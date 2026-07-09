//! Minimal self-contained PDF writer (PDF 1.4, standard-14 fonts — no
//! embedding, no external tools) plus builders for the four shared-file
//! types. Good typography is not the goal; faithful, printable exports are.

use crate::export::{parse_md_blocks, split_csv_line, MdBlock};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq)]
pub enum Font {
    Helv,
    HelvBold,
    Courier,
}

impl Font {
    fn res(&self) -> &'static str {
        match self {
            Font::Helv => "/F1",
            Font::HelvBold => "/F2",
            Font::Courier => "/F3",
        }
    }
    /// Approximate average glyph width as a fraction of font size.
    fn avg(&self) -> f32 {
        match self {
            Font::Helv => 0.50,
            Font::HelvBold => 0.54,
            Font::Courier => 0.60,
        }
    }
}

/// Escape text for a PDF literal string, using octal escapes for the
/// WinAnsi range and '?' beyond it.
fn esc_text(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\n' | '\r' | '\t' => out.push(' '),
            c if (c as u32) < 128 => out.push(c),
            '\u{2022}' => out.push_str("\\225"), // •
            '\u{2013}' => out.push_str("\\226"), // –
            '\u{2014}' => out.push_str("\\227"), // —
            '\u{2018}' => out.push_str("\\221"),
            '\u{2019}' => out.push_str("\\222"),
            '\u{201C}' => out.push_str("\\223"),
            '\u{201D}' => out.push_str("\\224"),
            '\u{2026}' => out.push_str("\\205"), // …
            c if (c as u32) <= 255 => out.push_str(&format!("\\{:03o}", c as u32)),
            _ => out.push('?'),
        }
    }
    out
}

pub struct Page {
    pub w: f32,
    pub h: f32,
    ops: String,
}

impl Page {
    pub fn new(w: f32, h: f32) -> Self {
        Page { w, h, ops: String::new() }
    }

    pub fn text_width(font: Font, size: f32, s: &str) -> f32 {
        s.chars().count() as f32 * size * font.avg()
    }

    /// y is measured from the TOP of the page.
    pub fn text(&mut self, x: f32, y: f32, font: Font, size: f32, gray: f32, s: &str) {
        self.ops.push_str(&format!(
            "BT {g:.2} {g:.2} {g:.2} rg {f} {size:.1} Tf {x:.1} {py:.1} Td ({t}) Tj ET\n",
            g = gray,
            f = font.res(),
            py = self.h - y,
            t = esc_text(s)
        ));
    }

    pub fn text_rgb(&mut self, x: f32, y: f32, font: Font, size: f32, rgb: (f32, f32, f32), s: &str) {
        self.ops.push_str(&format!(
            "BT {:.3} {:.3} {:.3} rg {f} {size:.1} Tf {x:.1} {py:.1} Td ({t}) Tj ET\n",
            rgb.0, rgb.1, rgb.2,
            f = font.res(),
            py = self.h - y,
            t = esc_text(s)
        ));
    }

    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, rgb: (f32, f32, f32)) {
        self.ops.push_str(&format!(
            "{:.3} {:.3} {:.3} rg {x:.1} {py:.1} {w:.1} {h:.1} re f\n",
            rgb.0, rgb.1, rgb.2,
            py = self.h - y - h
        ));
    }

    pub fn stroke_rect(&mut self, x: f32, y: f32, w: f32, h: f32, gray: f32, lw: f32) {
        self.ops.push_str(&format!(
            "{g:.2} {g:.2} {g:.2} RG {lw:.1} w {x:.1} {py:.1} {w:.1} {h:.1} re S\n",
            g = gray,
            py = self.h - y - h
        ));
    }

    pub fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, gray: f32, lw: f32) {
        self.ops.push_str(&format!(
            "{g:.2} {g:.2} {g:.2} RG {lw:.1} w {x1:.1} {p1:.1} m {x2:.1} {p2:.1} l S\n",
            g = gray,
            p1 = self.h - y1,
            p2 = self.h - y2
        ));
    }

    pub fn polyline(&mut self, pts: &[(f32, f32)], rgb: (f32, f32, f32), lw: f32) {
        if pts.len() < 2 {
            return;
        }
        self.ops.push_str(&format!("{:.3} {:.3} {:.3} RG {lw:.1} w 1 j 1 J ", rgb.0, rgb.1, rgb.2));
        for (i, (x, y)) in pts.iter().enumerate() {
            self.ops.push_str(&format!("{x:.1} {:.1} {} ", self.h - y, if i == 0 { "m" } else { "l" }));
        }
        self.ops.push_str("S\n");
    }

    /// Word-wrap `s` to `max_w` points at `size` in `font`.
    pub fn wrap(font: Font, size: f32, max_w: f32, s: &str) -> Vec<String> {
        let mut lines = vec![];
        let mut cur = String::new();
        for word in s.split_whitespace() {
            let cand = if cur.is_empty() { word.to_string() } else { format!("{cur} {word}") };
            if Page::text_width(font, size, &cand) > max_w && !cur.is_empty() {
                lines.push(cur);
                cur = word.to_string();
            } else {
                cur = cand;
            }
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    }
}

/// Assemble pages into a complete PDF file.
pub fn build_pdf(pages: &[Page]) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![];
    let n_pages = pages.len();
    // 1: catalog, 2: pages, 3-5: fonts, then (page, content) pairs.
    let kids: Vec<String> = (0..n_pages).map(|i| format!("{} 0 R", 6 + i * 2)).collect();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(format!("<< /Type /Pages /Kids [{}] /Count {n_pages} >>", kids.join(" ")).into_bytes());
    for base in ["Helvetica", "Helvetica-Bold", "Courier"] {
        objects.push(
            format!("<< /Type /Font /Subtype /Type1 /BaseFont /{base} /Encoding /WinAnsiEncoding >>")
                .into_bytes(),
        );
    }
    for (i, page) in pages.iter().enumerate() {
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.0} {:.0}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents {} 0 R >>",
                page.w,
                page.h,
                7 + i * 2
            )
            .into_bytes(),
        );
        let stream = page.ops.as_bytes();
        let mut content = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
        content.extend_from_slice(stream);
        content.extend_from_slice(b"\nendstream");
        objects.push(content);
    }

    let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![];
    for (i, obj) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(obj);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_pos = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in &offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/* ------------------------- builders ------------------------- */

const LETTER_W: f32 = 612.0;
const LETTER_H: f32 = 792.0;
const MARGIN: f32 = 56.0;
const INK: f32 = 0.12;
const DIM: f32 = 0.40;
const FAINT: f32 = 0.55;
const CHART_RGB: (f32, f32, f32) = (0.165, 0.471, 0.839); // #2a78d6

struct DocCursor {
    pages: Vec<Page>,
    y: f32,
}

impl DocCursor {
    fn new() -> Self {
        DocCursor { pages: vec![Page::new(LETTER_W, LETTER_H)], y: MARGIN }
    }
    fn page(&mut self) -> &mut Page {
        self.pages.last_mut().unwrap()
    }
    fn need(&mut self, h: f32) {
        if self.y + h > LETTER_H - MARGIN {
            self.pages.push(Page::new(LETTER_W, LETTER_H));
            self.y = MARGIN;
        }
    }
    fn para(&mut self, font: Font, size: f32, gray: f32, indent: f32, text: &str) {
        let max_w = LETTER_W - 2.0 * MARGIN - indent;
        for line in Page::wrap(font, size, max_w, text) {
            self.need(size * 1.45);
            self.y += size * 1.15;
            let y = self.y;
            self.page().text(MARGIN + indent, y, font, size, gray, &line);
            self.y += size * 0.30;
        }
    }
    fn gap(&mut self, h: f32) {
        self.y += h;
    }
}

fn table_to_pages(cur: &mut DocCursor, rows: &[Vec<String>]) {
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
    let table_w = LETTER_W - 2.0 * MARGIN;
    let col_w = table_w / cols as f32;
    let size = 9.0;
    let row_h = 17.0;
    for (ri, row) in rows.iter().enumerate() {
        cur.need(row_h + 2.0);
        let top = cur.y;
        if ri == 0 {
            cur.page().fill_rect(MARGIN, top, table_w, row_h, (0.93, 0.94, 0.95));
        }
        for (ci, cell) in row.iter().enumerate() {
            let font = if ri == 0 { Font::HelvBold } else { Font::Helv };
            // truncate to fit
            let mut text = cell.clone();
            while Page::text_width(font, size, &text) > col_w - 10.0 && text.chars().count() > 1 {
                text.pop();
            }
            let (x, y) = (MARGIN + ci as f32 * col_w + 5.0, top + 12.0);
            cur.page().text(x, y, font, size, INK, &text);
        }
        let y_line = top + row_h;
        let page = cur.page();
        page.line(MARGIN, y_line, MARGIN + table_w, y_line, 0.82, 0.5);
        cur.y += row_h;
    }
    cur.gap(6.0);
}

/// Markdown → paginated PDF document.
pub fn md_to_pdf(title: &str, md: &str) -> Vec<u8> {
    let mut cur = DocCursor::new();
    let blocks = parse_md_blocks(md);
    let has_h1 = matches!(blocks.first(), Some(MdBlock::Heading(1, _)));
    if !has_h1 {
        cur.para(Font::HelvBold, 20.0, INK, 0.0, title);
        cur.gap(8.0);
    }
    for b in blocks {
        match b {
            MdBlock::Heading(1, t) => {
                cur.gap(8.0);
                cur.para(Font::HelvBold, 20.0, INK, 0.0, &t);
                let y = cur.y + 2.0;
                cur.page().line(MARGIN, y, LETTER_W - MARGIN, y, 0.8, 0.7);
                cur.gap(10.0);
            }
            MdBlock::Heading(2, t) => {
                cur.gap(10.0);
                cur.para(Font::HelvBold, 15.0, INK, 0.0, &t);
                cur.gap(2.0);
            }
            MdBlock::Heading(_, t) => {
                cur.gap(8.0);
                cur.para(Font::HelvBold, 12.5, INK, 0.0, &t);
            }
            MdBlock::Para(t) => {
                cur.para(Font::Helv, 10.5, INK, 0.0, &t);
                cur.gap(4.0);
            }
            MdBlock::Bullet(t) => {
                let y_mark = cur.y + 12.0;
                cur.page().text(MARGIN + 6.0, y_mark, Font::Helv, 10.5, INK, "\u{2022}");
                cur.para(Font::Helv, 10.5, INK, 18.0, &t);
            }
            MdBlock::Numbered(t) => {
                cur.para(Font::Helv, 10.5, INK, 18.0, &format!("\u{2013}  {t}"));
            }
            MdBlock::Quote(t) => {
                cur.para(Font::Helv, 10.5, DIM, 16.0, &t);
            }
            MdBlock::Code(lines) => {
                cur.gap(4.0);
                for l in lines {
                    cur.para(Font::Courier, 8.8, 0.25, 10.0, if l.is_empty() { " " } else { &l });
                }
                cur.gap(4.0);
            }
            MdBlock::Table(rows) => table_to_pages(&mut cur, &rows),
        }
    }
    build_pdf(&cur.pages)
}

/// CSV → PDF table (landscape when wide).
pub fn csv_to_pdf(title: &str, csv: &str) -> Vec<u8> {
    let rows: Vec<Vec<String>> = csv
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(split_csv_line)
        .collect();
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(1);
    let landscape = cols > 6;
    let (w, h) = if landscape { (LETTER_H, LETTER_W) } else { (LETTER_W, LETTER_H) };
    let mut pages = vec![Page::new(w, h)];
    let mut y = MARGIN;
    pages.last_mut().unwrap().text(MARGIN, y + 14.0, Font::HelvBold, 15.0, INK, title);
    y += 30.0;
    let table_w = w - 2.0 * MARGIN;
    let col_w = table_w / cols.max(1) as f32;
    let size = 8.6;
    let row_h = 16.0;
    for (ri, row) in rows.iter().enumerate() {
        if y + row_h > h - MARGIN {
            pages.push(Page::new(w, h));
            y = MARGIN;
        }
        let page = pages.last_mut().unwrap();
        if ri == 0 {
            page.fill_rect(MARGIN, y, table_w, row_h, (0.93, 0.94, 0.95));
        }
        for (ci, cell) in row.iter().enumerate() {
            let font = if ri == 0 { Font::HelvBold } else { Font::Helv };
            let mut text = cell.clone();
            while Page::text_width(font, size, &text) > col_w - 8.0 && text.chars().count() > 1 {
                text.pop();
            }
            page.text(MARGIN + ci as f32 * col_w + 4.0, y + 11.5, font, size, INK, &text);
        }
        page.line(MARGIN, y + row_h, MARGIN + table_w, y + row_h, 0.84, 0.5);
        y += row_h;
    }
    build_pdf(&pages)
}

/// Slides JSON → one landscape 16:9 page per slide.
pub fn slides_to_pdf(v: &Value) -> Vec<u8> {
    const SW: f32 = 720.0;
    const SH: f32 = 405.0;
    let title = v["title"].as_str().unwrap_or("Presentation");
    let mut pages = vec![];

    let mut tp = Page::new(SW, SH);
    let tw = Page::text_width(Font::HelvBold, 30.0, title);
    tp.text((SW - tw) / 2.0, SH / 2.0, Font::HelvBold, 30.0, INK, title);
    pages.push(tp);

    for s in v["slides"].as_array().cloned().unwrap_or_default() {
        let mut p = Page::new(SW, SH);
        let st = s["title"].as_str().unwrap_or("");
        p.text(48.0, 62.0, Font::HelvBold, 22.0, INK, st);
        p.line(48.0, 74.0, SW - 48.0, 74.0, 0.8, 0.8);
        let mut y = 102.0;
        for b in s["bullets"].as_array().cloned().unwrap_or_default() {
            let text = crate::export::plain_inline(b.as_str().unwrap_or(""));
            p.text(56.0, y, Font::Helv, 14.0, INK, "\u{2022}");
            for line in Page::wrap(Font::Helv, 14.0, SW - 140.0, &text) {
                if y > SH - 50.0 {
                    break;
                }
                p.text(74.0, y, Font::Helv, 14.0, INK, &line);
                y += 21.0;
            }
            y += 4.0;
        }
        if let Some(notes) = s["notes"].as_str() {
            if !notes.trim().is_empty() {
                p.line(48.0, SH - 34.0, SW - 48.0, SH - 34.0, 0.85, 0.5);
                let mut ny = SH - 22.0;
                for line in Page::wrap(Font::Helv, 8.0, SW - 96.0, notes).into_iter().take(2) {
                    p.text(48.0, ny, Font::Helv, 8.0, FAINT, &line);
                    ny += 10.0;
                }
            }
        }
        pages.push(p);
    }
    build_pdf(&pages)
}

/// Dashboard JSON → PDF report with vector charts.
pub fn dash_to_pdf(v: &Value) -> Vec<u8> {
    let mut cur = DocCursor::new();
    cur.para(Font::HelvBold, 19.0, INK, 0.0, v["title"].as_str().unwrap_or("Dashboard"));
    cur.gap(8.0);
    let widgets = v["widgets"].as_array().cloned().unwrap_or_default();

    // Stat tiles: 3 per row.
    let stats: Vec<&Value> = widgets.iter().filter(|w| w["type"] == "stat").collect();
    if !stats.is_empty() {
        let tile_w = (LETTER_W - 2.0 * MARGIN - 20.0) / 3.0;
        for chunk in stats.chunks(3) {
            cur.need(64.0);
            let top = cur.y;
            for (i, s) in chunk.iter().enumerate() {
                let x = MARGIN + i as f32 * (tile_w + 10.0);
                let page = cur.page();
                page.stroke_rect(x, top, tile_w, 56.0, 0.85, 0.8);
                page.text(x + 10.0, top + 16.0, Font::Helv, 8.0, DIM, &s["label"].as_str().unwrap_or("").to_uppercase());
                let value = s["value"].as_str().map(str::to_string).unwrap_or_else(|| s["value"].to_string());
                page.text(x + 10.0, top + 37.0, Font::HelvBold, 17.0, INK, &value);
                page.text(x + 10.0, top + 49.0, Font::Helv, 8.0, FAINT, s["sub"].as_str().unwrap_or(""));
            }
            cur.y += 66.0;
        }
        cur.gap(6.0);
    }

    for w in widgets.iter().filter(|w| w["type"] != "stat") {
        let label = w["label"].as_str().unwrap_or("");
        match w["type"].as_str().unwrap_or("") {
            "bar" | "line" => {
                let data = crate::export::widget_data(w);
                if data.is_empty() {
                    continue;
                }
                cur.need(210.0);
                cur.para(Font::HelvBold, 11.5, INK, 0.0, label);
                cur.gap(4.0);
                let top = cur.y;
                let cw = LETTER_W - 2.0 * MARGIN;
                let ch = 160.0;
                let plot_l = MARGIN + 30.0;
                let plot_w = cw - 40.0;
                let plot_h = ch - 26.0;
                let max = data.iter().map(|(_, y)| *y).fold(f64::MIN, f64::max).max(0.0) as f32;
                let min = (data.iter().map(|(_, y)| *y).fold(0.0f64, f64::min)) as f32;
                let range = (max - min).max(1e-6);
                let y_of = |v: f32| top + plot_h * (1.0 - (v - min) / range);
                {
                    let page = cur.page();
                    for q in 1..=3 {
                        let gy = top + plot_h * q as f32 / 4.0;
                        page.line(plot_l, gy, plot_l + plot_w, gy, 0.9, 0.4);
                    }
                    page.text(plot_l - 26.0, y_of(max) + 3.0, Font::Helv, 7.5, FAINT, &format!("{max}"));
                }
                if w["type"] == "bar" {
                    let step = plot_w / data.len().max(1) as f32;
                    let bw = (step - 3.0).clamp(2.0, 46.0);
                    for (i, (x, yv)) in data.iter().enumerate() {
                        let bx = plot_l + step * i as f32 + (step - bw) / 2.0;
                        let (top_y, base_y) = (y_of(*yv as f32), y_of(0.0));
                        let page = cur.page();
                        page.fill_rect(bx, top_y.min(base_y), bw, (base_y - top_y).abs().max(0.6), CHART_RGB);
                        if data.len() <= 14 {
                            let lx = bx + bw / 2.0 - Page::text_width(Font::Helv, 7.0, x) / 2.0;
                            page.text(lx, top + plot_h + 12.0, Font::Helv, 7.0, FAINT, x);
                        }
                    }
                } else {
                    let n = (data.len().max(2) - 1) as f32;
                    let pts: Vec<(f32, f32)> = data
                        .iter()
                        .enumerate()
                        .map(|(i, (_, yv))| (plot_l + plot_w * i as f32 / n, y_of(*yv as f32)))
                        .collect();
                    {
                        let page = cur.page();
                        page.polyline(&pts, CHART_RGB, 1.6);
                        for (i, (px, py)) in pts.iter().enumerate() {
                            page.fill_rect(px - 1.8, py - 1.8, 3.6, 3.6, CHART_RGB);
                            if data.len() <= 12 {
                                let lx = px - Page::text_width(Font::Helv, 7.0, &data[i].0) / 2.0;
                                page.text(lx, top + plot_h + 12.0, Font::Helv, 7.0, FAINT, &data[i].0);
                            }
                        }
                        if let Some((last_x, last_y)) = pts.last() {
                            page.text_rgb(
                                last_x + 5.0,
                                last_y + 3.0,
                                Font::Helv,
                                8.0,
                                (0.3, 0.3, 0.3),
                                &format!("{}", data.last().unwrap().1),
                            );
                        }
                    }
                }
                let base = y_of(min.max(0.0));
                cur.page().line(plot_l, base, plot_l + plot_w, base, 0.6, 0.6);
                cur.y = top + ch + 16.0;
            }
            "table" => {
                cur.para(Font::HelvBold, 11.5, INK, 0.0, label);
                cur.gap(2.0);
                let mut rows: Vec<Vec<String>> = vec![];
                rows.push(
                    w["headers"].as_array().cloned().unwrap_or_default().iter()
                        .map(|h| h.as_str().unwrap_or("").to_string())
                        .collect(),
                );
                for r in w["rows"].as_array().cloned().unwrap_or_default() {
                    rows.push(
                        r.as_array().cloned().unwrap_or_default().iter()
                            .map(|c| c.as_str().map(str::to_string).unwrap_or_else(|| c.to_string()))
                            .collect(),
                    );
                }
                table_to_pages(&mut cur, &rows);
            }
            _ => {}
        }
    }
    build_pdf(&cur.pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join("qivreno-export-tests");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pdf_document() {
        let bytes = md_to_pdf("Report", "# Q3 Report\n\nRevenue grew **12%** across regions.\n\n- North: up\n- South: flat\n\n| Region | Rev |\n|---|---|\n| North | 40 |\n");
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.windows(5).any(|w| w == b"%%EOF"));
        std::fs::write(outdir().join("doc.pdf"), &bytes).unwrap();
    }

    #[test]
    fn pdf_slides_and_dash() {
        let deck: serde_json::Value = serde_json::from_str(
            r#"{"title":"Kickoff","slides":[{"title":"Agenda","bullets":["Intro","Numbers go here with a fairly long bullet line to force wrapping behavior in the renderer"],"notes":"stay brief"}]}"#,
        ).unwrap();
        let bytes = slides_to_pdf(&deck);
        assert!(bytes.starts_with(b"%PDF-1.4"));
        std::fs::write(outdir().join("deck.pdf"), &bytes).unwrap();

        let dash: serde_json::Value = serde_json::from_str(
            r#"{"title":"Ops","widgets":[{"type":"stat","label":"Orders","value":"312","sub":"this week"},{"type":"bar","label":"By day","data":[{"x":"Mon","y":40},{"x":"Tue","y":55},{"x":"Wed","y":32}]},{"type":"line","label":"Trend","data":[{"x":"W1","y":10},{"x":"W2","y":14},{"x":"W3","y":12}]},{"type":"table","label":"Top","headers":["SKU","Qty"],"rows":[["A-1","20"]]}]}"#,
        ).unwrap();
        let bytes = dash_to_pdf(&dash);
        assert!(bytes.starts_with(b"%PDF-1.4"));
        std::fs::write(outdir().join("dash.pdf"), &bytes).unwrap();

        let bytes = csv_to_pdf("Sheet", "Name,Qty\nWidget,5\nGadget,9");
        std::fs::write(outdir().join("sheet.pdf"), &bytes).unwrap();
    }
}
