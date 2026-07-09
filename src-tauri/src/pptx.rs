//! Slides JSON → .pptx. A PowerPoint file is a zip of OOXML parts; no
//! mature Rust crate generates them, so the minimal valid part set is
//! written by hand: content types, package rels, presentation, one slide
//! master + layout + theme (static boilerplate), and one slide part per
//! slide with plain text boxes (no placeholders — keeps the master trivial).

use serde_json::Value;
use std::io::Write;

fn xesc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;

const RELS_ROOT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;

fn theme_xml(accent: &str, text: &str) -> String { let t = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Qivreno"><a:themeElements><a:clrScheme name="Qivreno"><a:dk1><a:srgbClr val="0B1220"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="2563FF"/></a:accent1><a:accent2><a:srgbClr val="199E70"/></a:accent2><a:accent3><a:srgbClr val="C98500"/></a:accent3><a:accent4><a:srgbClr val="9085E9"/></a:accent4><a:accent5><a:srgbClr val="E66767"/></a:accent5><a:accent6><a:srgbClr val="D95926"/></a:accent6><a:hlink><a:srgbClr val="2563FF"/></a:hlink><a:folHlink><a:srgbClr val="9085E9"/></a:folHlink></a:clrScheme><a:fontScheme name="Qivreno"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#;
    t.replace("2563FF", accent).replace("0B1220", text) }

fn empty_sp_tree() -> String {
    r#"<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#.to_string()
}

fn slide_master() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>{tree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#,
        tree = empty_sp_tree()
    )
}

fn slide_layout() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout {NS} type="blank"><p:cSld>{tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#,
        tree = empty_sp_tree()
    )
}

/// A plain text box (no placeholder) at the given EMU rect.
fn text_box(
    id: u32,
    name: &str,
    x: i64,
    y: i64,
    cx: i64,
    cy: i64,
    paragraphs: &str,
) -> String {
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>"#
    )
}

fn run_p(text: &str, size_cpt: u32, bold: bool, bullet: bool, color: &str) -> String {
    let b = if bold { r#" b="1""# } else { "" };
    let bu = if bullet {
        r#"<a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>"#
    } else {
        ""
    };
    format!(
        r#"<a:p>{bu}<a:r><a:rPr lang="en-US" sz="{size_cpt}"{b} dirty="0"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>"#,
        xesc(text)
    )
}

fn slide_xml(title: &str, bullets: &[String], is_title_slide: bool, text: &str) -> String {
    let mut shapes = String::new();
    if is_title_slide {
        let p = format!(
            r#"<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="4400" b="1" dirty="0"><a:solidFill><a:srgbClr val="{text}"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>"#,
            xesc(title)
        );
        shapes.push_str(&text_box(2, "Title", 914400, 2743200, 10363200, 1371600, &p));
    } else {
        shapes.push_str(&text_box(
            2,
            "Title",
            838200,
            365125,
            10515600,
            1097280,
            &run_p(title, 3200, true, false, text),
        ));
        let body: String = bullets
            .iter()
            .map(|b| run_p(b, 1800, false, true, text))
            .collect();
        if !body.is_empty() {
            shapes.push_str(&text_box(3, "Body", 838200, 1700784, 10515600, 4525963, &body));
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld {NS}><p:cSld>{tree}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#,
        tree = empty_sp_tree()
    )
}

/// Pull brand colors out of a customer's .pptx/.potx template: theme
/// accent1 (accent) and dk1 (text). Handles both srgbClr and sysClr forms.
pub fn parse_theme_colors(bytes: &[u8]) -> Result<(String, String), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "that file isn't a valid PowerPoint file")?;
    let theme_name = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.contains("theme/theme") && n.ends_with(".xml"))
        .ok_or("no theme found in that file — is it a PowerPoint template?")?;
    let mut xml = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name(&theme_name).map_err(|e| e.to_string())?,
        &mut xml,
    )
    .map_err(|e| e.to_string())?;

    let color_after = |tag: &str| -> Option<String> {
        let start = xml.find(&format!("<a:{tag}>"))?;
        let end = start + xml[start..].find(&format!("</a:{tag}>"))?;
        let seg = &xml[start..end];
        if let Some(p) = seg.find("srgbClr val=\"") {
            return seg.get(p + 13..p + 19).map(str::to_string);
        }
        if let Some(p) = seg.find("lastClr=\"") {
            return seg.get(p + 9..p + 15).map(str::to_string);
        }
        None
    };
    let accent = color_after("accent1").ok_or("template theme has no accent1 color")?;
    let text = color_after("dk1").unwrap_or_else(|| "0B1220".into());
    Ok((accent.to_uppercase(), text.to_uppercase()))
}

pub fn slides_to_pptx(v: &Value, out: &std::path::Path, accent: &str, text: &str) -> Result<(), String> {
    let title = v["title"].as_str().unwrap_or("Presentation");
    let slides_json = v["slides"].as_array().cloned().unwrap_or_default();
    // slide 1 = title slide, then content slides
    let mut slide_parts: Vec<String> = vec![slide_xml(title, &[], true, text)];
    for s in &slides_json {
        let bullets: Vec<String> = s["bullets"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|b| crate::export::plain_inline(b.as_str().unwrap_or("")))
            .collect();
        slide_parts.push(slide_xml(s["title"].as_str().unwrap_or(""), &bullets, false, text));
    }
    let n = slide_parts.len();

    let mut content_types = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>"#,
    );
    for i in 1..=n {
        content_types.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#
        ));
    }
    content_types.push_str("</Types>");

    let mut pres_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>"#,
    );
    for i in 1..=n {
        pres_rels.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>"#,
            i + 1
        ));
    }
    pres_rels.push_str("</Relationships>");

    let mut sld_id_lst = String::new();
    for i in 1..=n {
        sld_id_lst.push_str(&format!(r#"<p:sldId id="{}" r:id="rId{}"/>"#, 255 + i, i + 1));
    }
    let presentation = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{sld_id_lst}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#
    );

    const MASTER_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;
    const LAYOUT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;
    const SLIDE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#;

    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = Default::default();
    let mut put = |zip: &mut zip::ZipWriter<std::fs::File>, name: &str, data: &str| -> Result<(), String> {
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        zip.write_all(data.as_bytes()).map_err(|e| e.to_string())
    };
    put(&mut zip, "[Content_Types].xml", &content_types)?;
    put(&mut zip, "_rels/.rels", RELS_ROOT)?;
    put(&mut zip, "ppt/presentation.xml", &presentation)?;
    put(&mut zip, "ppt/_rels/presentation.xml.rels", &pres_rels)?;
    put(&mut zip, "ppt/slideMasters/slideMaster1.xml", &slide_master())?;
    put(&mut zip, "ppt/slideMasters/_rels/slideMaster1.xml.rels", MASTER_RELS)?;
    put(&mut zip, "ppt/slideLayouts/slideLayout1.xml", &slide_layout())?;
    put(&mut zip, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", LAYOUT_RELS)?;
    put(&mut zip, "ppt/theme/theme1.xml", &theme_xml(accent, text))?;
    for (i, part) in slide_parts.iter().enumerate() {
        put(&mut zip, &format!("ppt/slides/slide{}.xml", i + 1), part)?;
        put(&mut zip, &format!("ppt/slides/_rels/slide{}.xml.rels", i + 1), SLIDE_RELS)?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn pptx_deck() {
        let d = std::env::temp_dir().join("qivreno-export-tests");
        std::fs::create_dir_all(&d).unwrap();
        let deck: serde_json::Value = serde_json::from_str(
            r#"{"title":"Kickoff <&>","slides":[{"title":"Agenda","bullets":["Intro","Q&A section"]},{"title":"Numbers","bullets":["Rev up 12%"]}]}"#,
        )
        .unwrap();
        super::slides_to_pptx(&deck, &d.join("deck.pptx"), "2563FF", "0B1220").unwrap();
    }

    #[test]
    fn theme_color_round_trip() {
        // Export a deck with custom brand colors, then re-import it as a
        // "customer template" and recover the same colors.
        let d = std::env::temp_dir().join("qivreno-export-tests");
        std::fs::create_dir_all(&d).unwrap();
        let deck: serde_json::Value =
            serde_json::from_str(r#"{"title":"T","slides":[{"title":"S","bullets":["b"]}]}"#).unwrap();
        let path = d.join("branded.pptx");
        super::slides_to_pptx(&deck, &path, "E91E63", "222831").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let (accent, text) = super::parse_theme_colors(&bytes).unwrap();
        assert_eq!(accent, "E91E63");
        assert_eq!(text, "222831");
    }
}
