//! Exports for shared files: Markdown → styled HTML document, slides JSON →
//! standalone HTML deck, dashboard JSON → standalone HTML with inline-SVG
//! charts, CSV → real .xlsx. All outputs are self-contained single files.

use serde_json::Value;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Minimal inline markdown: **bold**, *italic*, `code`, [text](url).
fn md_inline(s: &str) -> String {
    let mut out = esc(s);
    // code first so its contents aren't further styled
    out = regex_replace(&out, "`", "`", "<code>", "</code>");
    out = regex_replace(&out, "**", "**", "<strong>", "</strong>");
    out = regex_replace(&out, "*", "*", "<em>", "</em>");
    // links
    let mut res = String::new();
    let mut rest = out.as_str();
    while let Some(open) = rest.find('[') {
        if let Some(mid) = rest[open..].find("](") {
            if let Some(close) = rest[open + mid + 2..].find(')') {
                let text = &rest[open + 1..open + mid];
                let url = &rest[open + mid + 2..open + mid + 2 + close];
                if url.starts_with("http") {
                    res.push_str(&rest[..open]);
                    res.push_str(&format!("<a href=\"{url}\">{text}</a>"));
                    rest = &rest[open + mid + 3 + close..];
                    continue;
                }
            }
        }
        res.push_str(&rest[..=open]);
        rest = &rest[open + 1..];
    }
    res.push_str(rest);
    res
}

/// Replace paired delimiters with open/close tags.
fn regex_replace(s: &str, open_d: &str, close_d: &str, open_t: &str, close_t: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    loop {
        match rest.find(open_d) {
            Some(a) => {
                let after = &rest[a + open_d.len()..];
                match after.find(close_d) {
                    Some(b) if b > 0 => {
                        out.push_str(&rest[..a]);
                        out.push_str(open_t);
                        out.push_str(&after[..b]);
                        out.push_str(close_t);
                        rest = &after[b + close_d.len()..];
                    }
                    _ => {
                        out.push_str(&rest[..a + open_d.len()]);
                        rest = after;
                    }
                }
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    out
}

const DOC_CSS: &str = "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:760px;margin:48px auto;padding:0 24px;line-height:1.65;color:#1c2027;background:#fff}h1,h2,h3{line-height:1.3}h1{font-size:28px;border-bottom:1px solid #e3e6ea;padding-bottom:10px}h2{font-size:21px;margin-top:34px}h3{font-size:17px}code{background:#f0f2f5;border-radius:4px;padding:2px 5px;font-size:0.9em}pre{background:#f0f2f5;border-radius:8px;padding:14px;overflow-x:auto}table{border-collapse:collapse;width:100%;margin:18px 0}th,td{border:1px solid #e3e6ea;padding:7px 11px;text-align:left;font-size:14.5px}th{background:#f6f7f9}blockquote{border-left:3px solid #c6ccd4;margin:16px 0;padding:2px 18px;color:#555c66}@media print{body{margin:12px auto}}";

/// Markdown subset → complete HTML document.
pub fn md_to_html(title: &str, md: &str) -> String {
    let mut body = String::new();
    let mut in_list: Option<&str> = None;
    let mut in_code = false;
    let mut table_buf: Vec<String> = vec![];

    let close_list = |body: &mut String, in_list: &mut Option<&str>| {
        if let Some(tag) = in_list.take() {
            body.push_str(&format!("</{tag}>\n"));
        }
    };
    let flush_table = |body: &mut String, table_buf: &mut Vec<String>| {
        if table_buf.is_empty() {
            return;
        }
        body.push_str("<table>\n");
        for (i, row) in table_buf.iter().enumerate() {
            if row.trim_start().starts_with("|-") || row.replace(['|', '-', ':', ' '], "").is_empty() {
                continue;
            }
            let cells: Vec<&str> = row.trim().trim_matches('|').split('|').collect();
            let tag = if i == 0 { "th" } else { "td" };
            body.push_str("<tr>");
            for c in cells {
                body.push_str(&format!("<{tag}>{}</{tag}>", md_inline(c.trim())));
            }
            body.push_str("</tr>\n");
        }
        body.push_str("</table>\n");
        table_buf.clear();
    };

    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            close_list(&mut body, &mut in_list);
            flush_table(&mut body, &mut table_buf);
            body.push_str(if in_code { "</pre>\n" } else { "<pre>" });
            in_code = !in_code;
            continue;
        }
        if in_code {
            body.push_str(&esc(line));
            body.push('\n');
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with('|') {
            table_buf.push(line.to_string());
            continue;
        }
        flush_table(&mut body, &mut table_buf);
        if let Some(h) = trimmed.strip_prefix("### ") {
            close_list(&mut body, &mut in_list);
            body.push_str(&format!("<h3>{}</h3>\n", md_inline(h)));
        } else if let Some(h) = trimmed.strip_prefix("## ") {
            close_list(&mut body, &mut in_list);
            body.push_str(&format!("<h2>{}</h2>\n", md_inline(h)));
        } else if let Some(h) = trimmed.strip_prefix("# ") {
            close_list(&mut body, &mut in_list);
            body.push_str(&format!("<h1>{}</h1>\n", md_inline(h)));
        } else if let Some(q) = trimmed.strip_prefix("> ") {
            close_list(&mut body, &mut in_list);
            body.push_str(&format!("<blockquote>{}</blockquote>\n", md_inline(q)));
        } else if let Some(item) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            if in_list != Some("ul") {
                close_list(&mut body, &mut in_list);
                body.push_str("<ul>\n");
                in_list = Some("ul");
            }
            body.push_str(&format!("<li>{}</li>\n", md_inline(item)));
        } else if trimmed.len() > 2
            && trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
            && trimmed[1..].starts_with(". ")
        {
            if in_list != Some("ol") {
                close_list(&mut body, &mut in_list);
                body.push_str("<ol>\n");
                in_list = Some("ol");
            }
            body.push_str(&format!("<li>{}</li>\n", md_inline(&trimmed[3..])));
        } else if trimmed.is_empty() {
            close_list(&mut body, &mut in_list);
        } else {
            close_list(&mut body, &mut in_list);
            body.push_str(&format!("<p>{}</p>\n", md_inline(line)));
        }
    }
    close_list(&mut body, &mut in_list);
    flush_table(&mut body, &mut table_buf);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title><style>{DOC_CSS}</style></head><body>{body}</body></html>",
        esc(title)
    )
}

/// Slides JSON → keyboard-navigable standalone HTML deck.
pub fn slides_to_html(v: &Value) -> String {
    let title = v["title"].as_str().unwrap_or("Presentation");
    let mut slides_html = String::new();
    let slides = v["slides"].as_array().cloned().unwrap_or_default();
    // Title slide
    slides_html.push_str(&format!(
        "<section class=\"slide title-slide\"><h1>{}</h1></section>",
        esc(title)
    ));
    for s in &slides {
        let mut sec = format!("<section class=\"slide\"><h2>{}</h2>", esc(s["title"].as_str().unwrap_or("")));
        if let Some(bullets) = s["bullets"].as_array() {
            sec.push_str("<ul>");
            for b in bullets {
                sec.push_str(&format!("<li>{}</li>", md_inline(b.as_str().unwrap_or(""))));
            }
            sec.push_str("</ul>");
        }
        if let Some(notes) = s["notes"].as_str() {
            if !notes.trim().is_empty() {
                sec.push_str(&format!("<div class=\"notes\">{}</div>", esc(notes)));
            }
        }
        sec.push_str("</section>");
        slides_html.push_str(&sec);
    }
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{t}</title><style>
body{{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#14171d;color:#e8ebf0}}
.slide{{display:none;box-sizing:border-box;width:100vw;height:100vh;padding:7vh 9vw;flex-direction:column;justify-content:center}}
.slide.active{{display:flex}}
.title-slide h1{{font-size:7vh;text-align:center}}
h2{{font-size:5vh;margin:0 0 3vh;border-bottom:1px solid #333a46;padding-bottom:1.5vh}}
ul{{font-size:3.2vh;line-height:1.75;margin:0;padding-left:1.2em}}
li{{margin-bottom:1vh}}
.notes{{position:absolute;bottom:3vh;left:9vw;right:9vw;font-size:1.8vh;color:#8b94a3;border-top:1px solid #333a46;padding-top:1vh;display:none}}
body.show-notes .notes{{display:block}}
.hud{{position:fixed;bottom:14px;right:18px;font-size:12px;color:#5b6474}}
</style></head><body>{slides}
<div class="hud"><span id="pos"></span> · ←/→ navigate · N notes</div>
<script>
const S=[...document.querySelectorAll('.slide')];let i=0;
function show(n){{i=Math.max(0,Math.min(S.length-1,n));S.forEach((s,j)=>s.classList.toggle('active',j===i));document.getElementById('pos').textContent=(i+1)+' / '+S.length;}}
addEventListener('keydown',e=>{{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1);if(e.key.toLowerCase()==='n')document.body.classList.toggle('show-notes');}});
addEventListener('click',()=>show(i+1));show(0);
</script></body></html>"#,
        t = esc(title),
        slides = slides_html
    )
}

/* Chart colors validated (dataviz six-checks) against both the in-app dark
   surface and this export's light surface. */
const CHART_BLUE: &str = "#2a78d6";

fn bar_chart_svg(data: &[(String, f64)]) -> String {
    let w = 640.0;
    let h = 260.0;
    let pad_l = 46.0;
    let pad_b = 28.0;
    let pad_t = 14.0;
    let max = data.iter().map(|(_, y)| *y).fold(f64::MIN, f64::max).max(0.0);
    let min = data.iter().map(|(_, y)| *y).fold(0.0f64, f64::min);
    let range = (max - min).max(1e-9);
    let plot_w = w - pad_l - 10.0;
    let plot_h = h - pad_t - pad_b;
    let n = data.len().max(1) as f64;
    let step = plot_w / n;
    let bw = (step - 2.0).clamp(3.0, 56.0); // 2px surface gap between bars
    let y_of = |v: f64| pad_t + plot_h * (1.0 - (v - min) / range);
    let base_y = y_of(0.0);
    let mut svg = format!(
        "<svg viewBox=\"0 0 {w} {h}\" xmlns=\"http://www.w3.org/2000/svg\" font-family=\"system-ui\" font-size=\"11\">"
    );
    // recessive gridlines at quarters
    for q in 1..=3 {
        let gy = pad_t + plot_h * q as f64 / 4.0;
        svg.push_str(&format!(
            "<line x1=\"{pad_l}\" x2=\"{}\" y1=\"{gy:.1}\" y2=\"{gy:.1}\" stroke=\"#e1e0d9\" stroke-width=\"1\"/>",
            w - 10.0
        ));
    }
    let max_i = data
        .iter()
        .enumerate()
        .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
        .map(|(i, _)| i);
    for (i, (x, y)) in data.iter().enumerate() {
        let bx = pad_l + step * i as f64 + (step - bw) / 2.0;
        let (top, bh) = if *y >= 0.0 {
            (y_of(*y), base_y - y_of(*y))
        } else {
            (base_y, y_of(*y) - base_y)
        };
        // rounded data end (4px), flat baseline end
        svg.push_str(&format!(
            "<path d=\"M{bx:.1} {b:.1} v{neg_h:.1} q0 -4 4 -4 h{iw:.1} q4 0 4 4 v{h2:.1} z\" fill=\"{CHART_BLUE}\"><title>{xt}: {y}</title></path>",
            b = top + bh,
            neg_h = -(bh - 4.0).max(0.0),
            iw = bw - 8.0,
            h2 = (bh - 4.0).max(0.0),
            xt = esc(x),
        ));
        // selective direct label: max only
        if Some(i) == max_i {
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" fill=\"#52514e\">{}</text>",
                bx + bw / 2.0,
                top - 5.0,
                y
            ));
        }
        if data.len() <= 14 {
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" fill=\"#898781\">{}</text>",
                bx + bw / 2.0,
                h - 8.0,
                esc(x)
            ));
        }
    }
    // baseline + y extremes
    svg.push_str(&format!(
        "<line x1=\"{pad_l}\" x2=\"{}\" y1=\"{base_y:.1}\" y2=\"{base_y:.1}\" stroke=\"#c3c2b7\" stroke-width=\"1\"/>",
        w - 10.0
    ));
    svg.push_str(&format!(
        "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"end\" fill=\"#898781\">{max}</text>",
        pad_l - 6.0,
        y_of(max) + 4.0
    ));
    svg.push_str("</svg>");
    svg
}

fn line_chart_svg(data: &[(String, f64)]) -> String {
    let w = 640.0;
    let h = 260.0;
    let pad_l = 46.0;
    let pad_b = 28.0;
    let pad_t = 14.0;
    let max = data.iter().map(|(_, y)| *y).fold(f64::MIN, f64::max);
    let min = data.iter().map(|(_, y)| *y).fold(f64::MAX, f64::min).min(0.0);
    let range = (max - min).max(1e-9);
    let plot_w = w - pad_l - 14.0;
    let plot_h = h - pad_t - pad_b;
    let n = (data.len().max(2) - 1) as f64;
    let x_of = |i: usize| pad_l + plot_w * i as f64 / n;
    let y_of = |v: f64| pad_t + plot_h * (1.0 - (v - min) / range);
    let mut svg = format!(
        "<svg viewBox=\"0 0 {w} {h}\" xmlns=\"http://www.w3.org/2000/svg\" font-family=\"system-ui\" font-size=\"11\">"
    );
    for q in 1..=3 {
        let gy = pad_t + plot_h * q as f64 / 4.0;
        svg.push_str(&format!(
            "<line x1=\"{pad_l}\" x2=\"{}\" y1=\"{gy:.1}\" y2=\"{gy:.1}\" stroke=\"#e1e0d9\" stroke-width=\"1\"/>",
            w - 14.0
        ));
    }
    let pts: Vec<String> = data
        .iter()
        .enumerate()
        .map(|(i, (_, y))| format!("{:.1},{:.1}", x_of(i), y_of(*y)))
        .collect();
    svg.push_str(&format!(
        "<polyline points=\"{}\" fill=\"none\" stroke=\"{CHART_BLUE}\" stroke-width=\"2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>",
        pts.join(" ")
    ));
    for (i, (x, y)) in data.iter().enumerate() {
        svg.push_str(&format!(
            "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"4\" fill=\"{CHART_BLUE}\" stroke=\"#ffffff\" stroke-width=\"2\"><title>{}: {}</title></circle>",
            x_of(i),
            y_of(*y),
            esc(x),
            y
        ));
        if data.len() <= 12 {
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"middle\" fill=\"#898781\">{}</text>",
                x_of(i),
                h - 8.0,
                esc(x)
            ));
        }
    }
    // last-value direct label
    if let Some((_, y)) = data.last() {
        svg.push_str(&format!(
            "<text x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"start\" fill=\"#52514e\">{y}</text>",
            x_of(data.len() - 1) + 7.0,
            y_of(*y) + 4.0
        ));
    }
    svg.push_str(&format!(
        "<line x1=\"{pad_l}\" x2=\"{}\" y1=\"{:.1}\" y2=\"{:.1}\" stroke=\"#c3c2b7\" stroke-width=\"1\"/>",
        w - 14.0,
        y_of(min.max(0.0)),
        y_of(min.max(0.0))
    ));
    svg.push_str("</svg>");
    svg
}

pub fn widget_data(w: &Value) -> Vec<(String, f64)> {
    w["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|p| {
                    (
                        p["x"].as_str().map(str::to_string).unwrap_or_else(|| p["x"].to_string()),
                        p["y"].as_f64().unwrap_or(0.0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Dashboard JSON → standalone HTML report with inline-SVG charts.
pub fn dash_to_html(v: &Value) -> String {
    let title = v["title"].as_str().unwrap_or("Dashboard");
    let mut body = format!("<h1>{}</h1>", esc(title));
    let widgets = v["widgets"].as_array().cloned().unwrap_or_default();
    let stats: Vec<&Value> = widgets.iter().filter(|w| w["type"] == "stat").collect();
    if !stats.is_empty() {
        body.push_str("<div class=\"stats\">");
        for s in stats {
            body.push_str(&format!(
                "<div class=\"stat\"><div class=\"stat-label\">{}</div><div class=\"stat-value\">{}</div><div class=\"stat-sub\">{}</div></div>",
                esc(s["label"].as_str().unwrap_or("")),
                esc(s["value"].as_str().map(str::to_string).unwrap_or_else(|| s["value"].to_string()).as_str()),
                esc(s["sub"].as_str().unwrap_or(""))
            ));
        }
        body.push_str("</div>");
    }
    for w in widgets.iter().filter(|w| w["type"] != "stat") {
        let label = esc(w["label"].as_str().unwrap_or(""));
        body.push_str(&format!("<div class=\"card\"><h2>{label}</h2>"));
        match w["type"].as_str().unwrap_or("") {
            "bar" => body.push_str(&bar_chart_svg(&widget_data(w))),
            "line" => body.push_str(&line_chart_svg(&widget_data(w))),
            "table" => {
                body.push_str("<table><tr>");
                for hcell in w["headers"].as_array().cloned().unwrap_or_default() {
                    body.push_str(&format!("<th>{}</th>", esc(hcell.as_str().unwrap_or(""))));
                }
                body.push_str("</tr>");
                for row in w["rows"].as_array().cloned().unwrap_or_default() {
                    body.push_str("<tr>");
                    for cell in row.as_array().cloned().unwrap_or_default() {
                        body.push_str(&format!(
                            "<td>{}</td>",
                            esc(cell.as_str().map(str::to_string).unwrap_or_else(|| cell.to_string()).as_str())
                        ));
                    }
                    body.push_str("</tr>");
                }
                body.push_str("</table>");
            }
            other => body.push_str(&format!("<p>(unsupported widget type: {})</p>", esc(other))),
        }
        body.push_str("</div>");
    }
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{t}</title><style>{DOC_CSS}\
         .stats{{display:flex;gap:14px;flex-wrap:wrap;margin:20px 0}}\
         .stat{{border:1px solid #e3e6ea;border-radius:10px;padding:14px 18px;min-width:150px}}\
         .stat-label{{font-size:12px;color:#52514e;text-transform:uppercase;letter-spacing:0.05em}}\
         .stat-value{{font-size:30px;font-weight:650;margin-top:2px}}\
         .stat-sub{{font-size:12px;color:#898781}}\
         .card{{border:1px solid #e3e6ea;border-radius:10px;padding:16px 18px;margin:16px 0}}\
         .card h2{{font-size:15px;margin:0 0 10px;border:none}}</style></head><body>{body}</body></html>",
        t = esc(title)
    )
}

/// CSV (header row) → .xlsx bytes written to `out`.
pub fn csv_to_xlsx(csv: &str, out: &std::path::Path) -> Result<(), String> {
    use rust_xlsxwriter::{Format, Workbook};
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    let bold = Format::new().set_bold();
    for (r, line) in csv.lines().enumerate() {
        for (c, cell) in split_csv_line(line).iter().enumerate() {
            let (r32, c16) = (r as u32, c as u16);
            if r == 0 {
                ws.write_with_format(r32, c16, cell.as_str(), &bold).map_err(|e| e.to_string())?;
            } else if let Ok(n) = cell.trim().parse::<f64>() {
                ws.write(r32, c16, n).map_err(|e| e.to_string())?;
            } else {
                ws.write(r32, c16, cell.as_str()).map_err(|e| e.to_string())?;
            }
        }
    }
    wb.save(out).map_err(|e| e.to_string())
}

/// Markdown block IR shared by the DOCX and PDF builders (the HTML path has
/// its own streaming renderer above).
#[derive(Debug, Clone)]
pub enum MdBlock {
    Heading(u8, String),
    Para(String),
    Bullet(String),
    Numbered(String),
    Quote(String),
    Code(Vec<String>),
    Table(Vec<Vec<String>>),
}

/// Strip inline markdown markers, keeping readable text.
pub fn plain_inline(s: &str) -> String {
    let mut out = s.replace("**", "").replace('`', "");
    // lone *emphasis* markers
    out = out.replace('*', "");
    // [text](url) -> text
    while let (Some(a), Some(b)) = (out.find("]("), out.find('[')) {
        if b < a {
            if let Some(c) = out[a..].find(')') {
                let text = out[b + 1..a].to_string();
                out.replace_range(b..a + c + 1, &text);
                continue;
            }
        }
        break;
    }
    out
}

pub fn parse_md_blocks(md: &str) -> Vec<MdBlock> {
    let mut blocks = vec![];
    let mut code: Option<Vec<String>> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    for line in md.lines() {
        let t = line.trim_start();
        if t.starts_with("```") {
            if let Some(lines) = code.take() {
                blocks.push(MdBlock::Code(lines));
            } else {
                code = Some(vec![]);
            }
            continue;
        }
        if let Some(lines) = code.as_mut() {
            lines.push(line.to_string());
            continue;
        }
        if t.starts_with('|') {
            if !(t.starts_with("|-") || t.replace(['|', '-', ':', ' '], "").is_empty()) {
                let cells: Vec<String> = t
                    .trim()
                    .trim_matches('|')
                    .split('|')
                    .map(|c| plain_inline(c.trim()))
                    .collect();
                table.get_or_insert_with(Vec::new).push(cells);
            }
            continue;
        }
        if let Some(rows) = table.take() {
            blocks.push(MdBlock::Table(rows));
        }
        if let Some(h) = t.strip_prefix("### ") {
            blocks.push(MdBlock::Heading(3, plain_inline(h)));
        } else if let Some(h) = t.strip_prefix("## ") {
            blocks.push(MdBlock::Heading(2, plain_inline(h)));
        } else if let Some(h) = t.strip_prefix("# ") {
            blocks.push(MdBlock::Heading(1, plain_inline(h)));
        } else if let Some(q) = t.strip_prefix("> ") {
            blocks.push(MdBlock::Quote(plain_inline(q)));
        } else if let Some(i) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            blocks.push(MdBlock::Bullet(plain_inline(i)));
        } else if t.len() > 2 && t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t[1..].starts_with(". ") {
            blocks.push(MdBlock::Numbered(plain_inline(&t[3..])));
        } else if !t.is_empty() {
            blocks.push(MdBlock::Para(plain_inline(line.trim())));
        }
    }
    if let Some(lines) = code.take() {
        blocks.push(MdBlock::Code(lines));
    }
    if let Some(rows) = table.take() {
        blocks.push(MdBlock::Table(rows));
    }
    blocks
}

/// CSV field splitting with double-quote support.
pub fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = vec![];
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(cur.trim().to_string());
                cur = String::new();
            }
            _ => cur.push(ch),
        }
    }
    fields.push(cur.trim().to_string());
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md_document() {
        let html = md_to_html("T", "# Head\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n**bold** and `code`");
        assert!(html.contains("<h1>Head</h1>"));
        assert!(html.contains("<li>a</li>"));
        assert!(html.contains("<th>A</th>"));
        assert!(html.contains("<td>1</td>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<code>code</code>"));
    }

    #[test]
    fn slides_deck() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"title":"Deck","slides":[{"title":"S1","bullets":["b1","b2"],"notes":"n"}]}"#,
        ).unwrap();
        let html = slides_to_html(&v);
        assert!(html.contains("<h1>Deck</h1>"));
        assert!(html.contains("<li>b1</li>"));
        assert!(html.contains("class=\"notes\""));
    }

    #[test]
    fn dashboard_charts() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"title":"D","widgets":[
                {"type":"stat","label":"Rev","value":"$1","sub":"mo"},
                {"type":"bar","label":"B","data":[{"x":"Jan","y":3},{"x":"Feb","y":7}]},
                {"type":"line","label":"L","data":[{"x":"W1","y":1},{"x":"W2","y":4}]},
                {"type":"table","label":"T","headers":["H"],"rows":[["r"]]}]}"#,
        ).unwrap();
        let html = dash_to_html(&v);
        assert!(html.contains("stat-value"));
        assert!(html.matches("<svg").count() == 2);
        assert!(html.contains("<title>Feb: 7</title>"));
        assert!(html.contains("<th>H</th>"));
    }

    #[test]
    fn csv_xlsx() {
        let out = std::env::temp_dir().join("qivreno-test.xlsx");
        csv_to_xlsx("Name,Qty\nWidget,5\n\"A, Inc\",2", &out).unwrap();
        assert!(std::fs::metadata(&out).unwrap().len() > 500);
        std::fs::remove_file(&out).ok();
        assert_eq!(split_csv_line("a,\"b,c\",d"), vec!["a", "b,c", "d"]);
    }
}
