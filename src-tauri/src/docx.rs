//! Markdown → .docx via docx-rs. Headings/paragraphs/lists/quotes/code and
//! tables map onto native Word constructs; inline **bold** becomes bold runs.

use crate::export::{parse_md_blocks, MdBlock};
use docx_rs::{Docx, Paragraph, Run, RunFonts, Table, TableCell, TableRow};

/// Split "a **b** c" into runs with a bold flag.
fn bold_runs(text: &str) -> Vec<(String, bool)> {
    let mut out = vec![];
    let mut rest = text;
    loop {
        match rest.find("**") {
            Some(a) => match rest[a + 2..].find("**") {
                Some(b) => {
                    if a > 0 {
                        out.push((rest[..a].to_string(), false));
                    }
                    out.push((rest[a + 2..a + 2 + b].to_string(), true));
                    rest = &rest[a + 4 + b..];
                }
                None => {
                    out.push((rest.to_string(), false));
                    break;
                }
            },
            None => {
                if !rest.is_empty() {
                    out.push((rest.to_string(), false));
                }
                break;
            }
        }
    }
    if out.is_empty() {
        out.push((String::new(), false));
    }
    out
}

fn para(text: &str, size: usize, all_bold: bool) -> Paragraph {
    let mut p = Paragraph::new();
    for (seg, bold) in bold_runs(text) {
        let mut run = Run::new().add_text(seg).size(size);
        if bold || all_bold {
            run = run.bold();
        }
        p = p.add_run(run);
    }
    p
}

pub fn md_to_docx(title: &str, md: &str, out: &std::path::Path) -> Result<(), String> {
    let blocks = parse_md_blocks(md);
    let mut docx = Docx::new();
    if !matches!(blocks.first(), Some(MdBlock::Heading(1, _))) {
        docx = docx.add_paragraph(para(title, 40, true));
    }
    for b in blocks {
        docx = match b {
            MdBlock::Heading(1, t) => docx.add_paragraph(para(&t, 40, true)),
            MdBlock::Heading(2, t) => docx.add_paragraph(para(&t, 30, true)),
            MdBlock::Heading(_, t) => docx.add_paragraph(para(&t, 25, true)),
            MdBlock::Para(t) => docx.add_paragraph(para(&t, 22, false)),
            MdBlock::Bullet(t) => docx.add_paragraph(
                para(&format!("\u{2022}  {t}"), 22, false).indent(Some(400), None, None, None),
            ),
            MdBlock::Numbered(t) => docx.add_paragraph(
                para(&format!("\u{2013}  {t}"), 22, false).indent(Some(400), None, None, None),
            ),
            MdBlock::Quote(t) => docx.add_paragraph(
                para(&t, 22, false).indent(Some(500), None, None, None),
            ),
            MdBlock::Code(lines) => {
                let mut d = docx;
                for l in lines {
                    d = d.add_paragraph(
                        Paragraph::new().add_run(
                            Run::new()
                                .add_text(if l.is_empty() { " ".to_string() } else { l })
                                .size(18)
                                .fonts(RunFonts::new().ascii("Courier New")),
                        ),
                    );
                }
                d
            }
            MdBlock::Table(rows) => {
                let table_rows: Vec<TableRow> = rows
                    .iter()
                    .enumerate()
                    .map(|(ri, row)| {
                        TableRow::new(
                            row.iter()
                                .map(|c| TableCell::new().add_paragraph(para(c, 20, ri == 0)))
                                .collect(),
                        )
                    })
                    .collect();
                docx.add_table(Table::new(table_rows))
            }
        };
        // paragraph spacing comes from Word defaults; add a blank line after tables
    }
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    docx.build().pack(file).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn docx_document() {
        let d = std::env::temp_dir().join("qivreno-export-tests");
        std::fs::create_dir_all(&d).unwrap();
        super::md_to_docx(
            "Report",
            "# Q3 Report\n\nRevenue grew **12%**.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n",
            &d.join("doc.docx"),
        )
        .unwrap();
    }
}
