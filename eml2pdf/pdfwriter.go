package main

// Eingebauter PDF-Erzeuger: braucht weder Edge noch Office und funktioniert daher immer.
// Wird für Bild- und Textanlagen benutzt und als Rückfallebene für das E-Mail-PDF.

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"strings"
	"unicode"

	"github.com/go-pdf/fpdf"
	"golang.org/x/net/html"
)

//go:embed fonts/DejaVuSans.ttf
var fontRegular []byte

//go:embed fonts/DejaVuSans-Bold.ttf
var fontBold []byte

//go:embed fonts/DejaVuSansMono.ttf
var fontMono []byte

const (
	margin   = 15.0 // mm
	fontSize = 10.0 // pt
	lineH    = 5.0  // mm
)

type pdfDoc struct {
	pdf  *fpdf.Fpdf
	imgN int
}

func newPDFDoc(title string) *pdfDoc {
	p := fpdf.New("P", "mm", "A4", "")
	p.SetMargins(margin, margin, margin)
	p.SetAutoPageBreak(true, margin)
	p.AddUTF8FontFromBytes("sans", "", fontRegular)
	p.AddUTF8FontFromBytes("sans", "B", fontBold)
	p.AddUTF8FontFromBytes("mono", "", fontMono)
	p.SetTitle(title, true)
	p.SetCreator(appName, true)
	p.AliasNbPages("{nb}")
	p.SetFooterFunc(func() {
		p.SetY(-10)
		p.SetFont("sans", "", 7)
		p.SetTextColor(120, 120, 120)
		p.CellFormat(0, 4, fmt.Sprintf("Seite %d von {nb}", p.PageNo()), "", 0, "R", false, 0, "")
		p.SetTextColor(0, 0, 0)
	})
	p.AddPage()
	p.SetFont("sans", "", fontSize)
	return &pdfDoc{pdf: p}
}

// strictText: Notfallmodus, nur noch einfache (westeuropäische) Zeichen ausgeben.
var strictText bool

// cleanText entfernt Steuerzeichen, die im PDF Probleme machen.
func cleanText(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return r
		case r == '\u00a0':
			return ' '
		case r > 0xFFFF || (r >= 0xD800 && r <= 0xDFFF) || (r >= 0xE000 && r <= 0xF8FF):
			return -1 // Emojis u. ä. kann die PDF-Schrift nicht darstellen
		case strictText && r > 0x2FF && !(r >= 0x2000 && r <= 0x20CF):
			return '?'
		case unicode.IsControl(r) || r == '\ufeff' || r == '\u200b' || r == '\u200c' || r == '\u200d':
			return -1
		}
		return r
	}, s)
}

func (d *pdfDoc) write(s string, bold bool, size float64) {
	style := ""
	if bold {
		style = "B"
	}
	d.pdf.SetFont("sans", style, size)
	d.pdf.Write(size*0.5, cleanText(s))
}

func (d *pdfDoc) mono(s string) {
	d.pdf.SetFont("mono", "", 9)
	d.pdf.Write(4.4, strings.ReplaceAll(cleanText(s), "\t", "    "))
}

func (d *pdfDoc) ln(h float64) { d.pdf.Ln(h) }

func (d *pdfDoc) rule() {
	w, _ := d.pdf.GetPageSize()
	y := d.pdf.GetY()
	d.pdf.SetLineWidth(0.4)
	d.pdf.Line(margin, y, w-margin, y)
	d.pdf.SetY(y + 3)
}

// pdfImage bringt ein Bild in eine Form, die fpdf sicher versteht (JPEG oder einfaches PNG).
func pdfImage(data []byte) (out []byte, kind string, w, h int, err error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", 0, 0, err
	}
	if format == "jpeg" && cfg.ColorModel != nil {
		if _, err := jpeg.Decode(bytes.NewReader(data)); err == nil {
			return data, "JPG", cfg.Width, cfg.Height, nil
		}
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", 0, 0, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, "", 0, 0, err
	}
	b := img.Bounds()
	return buf.Bytes(), "PNG", b.Dx(), b.Dy(), nil
}

// image fügt ein Bild in Originalgröße (96 dpi) ein, höchstens so groß wie die Seite.
func (d *pdfDoc) image(data []byte, fullPage bool) error {
	raw, kind, pw, ph, err := pdfImage(data)
	if err != nil {
		return err
	}
	pageW, pageH := d.pdf.GetPageSize()
	maxW, maxH := pageW-2*margin, pageH-2*margin-5
	w, h := float64(pw)*25.4/96, float64(ph)*25.4/96
	if fullPage || w > maxW {
		h, w = h*maxW/w, maxW
	}
	if h > maxH {
		w, h = w*maxH/h, maxH
	}
	d.imgN++
	name := fmt.Sprintf("bild%d", d.imgN)
	d.pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: kind}, bytes.NewReader(raw))
	if d.pdf.Err() {
		return d.pdf.Error()
	}
	if d.pdf.GetX() > margin+0.5 {
		d.ln(lineH)
	}
	y := d.pdf.GetY()
	if y+h > pageH-margin {
		d.pdf.AddPage()
		y = d.pdf.GetY()
	}
	d.pdf.ImageOptions(name, margin, y, w, h, false, fpdf.ImageOptions{ImageType: kind}, 0, "")
	d.pdf.SetXY(margin, y+h+2)
	return nil
}

func (d *pdfDoc) save(path string) (err error) {
	if d.pdf.Err() {
		return d.pdf.Error()
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := d.pdf.Output(f); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	return f.Close()
}

// safely fängt Abstürze der PDF-Bibliothek ab (z. B. bei exotischen Zeichen).
func safely(fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("interner Fehler: %v", r)
		}
	}()
	return fn()
}

// ---------------------------------------------------------------- E-Mail

func builtinMailPDF(m *Mail, attachmentNames []string, out string) error {
	err := builtinMailPDFOnce(m, attachmentNames, out)
	if err != nil {
		// Notfall: nur einfache Zeichen, keine Bilder
		logf("Eingebauter PDF-Erzeuger: %v – versuche vereinfachte Fassung", err)
		strictText = true
		defer func() { strictText = false }()
		inline := m.Inline
		m.Inline = nil
		err = builtinMailPDFOnce(m, attachmentNames, out)
		m.Inline = inline
	}
	return err
}

func builtinMailPDFOnce(m *Mail, attachmentNames []string, out string) error {
	return safely(func() error {
		subject := m.Subject
		if subject == "" {
			subject = "(ohne Betreff)"
		}
		d := newPDFDoc(subject)
		d.write(subject, true, 14)
		d.ln(9)
		rows := [][2]string{{"Von", m.From}, {"An", m.To}}
		if m.Cc != "" {
			rows = append(rows, [2]string{"Cc", m.Cc})
		}
		if !m.Date.IsZero() {
			rows = append(rows, [2]string{"Datum", m.Date.Format("02.01.2006 15:04")})
		}
		if len(attachmentNames) > 0 {
			rows = append(rows, [2]string{"Anlagen", strings.Join(attachmentNames, ", ")})
		}
		for _, r := range rows {
			d.write(r[0]+": ", true, 9)
			d.write(r[1], false, 9)
			d.ln(4.8)
		}
		d.ln(1)
		d.rule()

		if m.HTML != "" {
			r := &htmlRenderer{d: d, inline: m.Inline, atLineStart: true}
			if err := r.render(m.HTML); err != nil {
				return err
			}
		} else {
			d.write(m.Text, false, fontSize)
		}
		return d.save(out)
	})
}

func builtinTextPDF(title, text, out string) error {
	return safely(func() error {
		d := newPDFDoc(title)
		d.mono(text)
		return d.save(out)
	})
}

func builtinImagePDF(title string, data []byte, out string) error {
	return safely(func() error {
		d := newPDFDoc(title)
		if err := d.image(data, true); err != nil {
			return fmt.Errorf("Bild nicht lesbar: %w", err)
		}
		return d.save(out)
	})
}

func builtinHTMLPDF(title, page, out string) error {
	return safely(func() error {
		d := newPDFDoc(title)
		r := &htmlRenderer{d: d, atLineStart: true}
		if err := r.render(page); err != nil {
			return err
		}
		return d.save(out)
	})
}

// ---------------------------------------------------------------- HTML als Fließtext

type htmlRenderer struct {
	d           *pdfDoc
	inline      map[string]Part
	bold, pre   int
	size        float64
	atLineStart bool
	space       bool // Leerzeichen steht noch aus
	cellDepth   int  // >0: in kleiner Tabellenzelle, keine Absätze
	blank       bool // letzte Zeile war eine Leerzeile
	lists       []int
}

var skipTags = map[string]bool{"head": true, "style": true, "script": true, "title": true, "meta": true,
	"link": true, "noscript": true, "template": true, "svg": true, "object": true, "iframe": true}

var blockTags = map[string]bool{"p": true, "div": true, "h1": true, "h2": true, "h3": true, "h4": true,
	"h5": true, "h6": true, "blockquote": true, "ul": true, "ol": true, "table": true, "tr": true,
	"section": true, "article": true, "header": true, "footer": true, "center": true, "address": true,
	"pre": true, "form": true, "dl": true, "dt": true, "dd": true, "li": true, "hr": true}

var paragraphTags = map[string]bool{"p": true, "h1": true, "h2": true, "h3": true, "h4": true,
	"h5": true, "h6": true, "blockquote": true, "ul": true, "ol": true, "table": true, "pre": true}

func (r *htmlRenderer) render(src string) error {
	root, err := html.Parse(strings.NewReader(src))
	if err != nil {
		return err
	}
	r.size = fontSize
	r.walk(root)
	return nil
}

func (r *htmlRenderer) newline() {
	r.space = false
	if r.atLineStart {
		return
	}
	r.d.ln(r.size * 0.5)
	r.atLineStart = true
}

func (r *htmlRenderer) paragraph() {
	r.newline()
	if !r.blank {
		r.d.ln(2.5)
		r.blank = true
	}
}

func (r *htmlRenderer) textNode(s string) {
	if r.pre > 0 {
		for i, l := range strings.Split(s, "\n") {
			if i > 0 {
				r.d.ln(4.4)
			}
			if l != "" {
				r.d.mono(l)
			}
		}
		r.atLineStart = strings.HasSuffix(s, "\n")
		r.blank = false
		return
	}
	words := strings.FieldsFunc(s, unicode.IsSpace)
	if len(words) == 0 {
		if s != "" {
			r.space = true
		}
		return
	}
	lead := unicode.IsSpace([]rune(s)[0])
	out := strings.Join(words, " ")
	if (r.space || lead) && !r.atLineStart {
		out = " " + out
	}
	r.d.write(out, r.bold > 0, r.size)
	rs := []rune(s)
	r.space = unicode.IsSpace(rs[len(rs)-1])
	r.atLineStart, r.blank = false, false
}

// isSmallCell: Tabellenzelle ohne verschachtelte Tabelle und mit wenig Text
// (echte Datentabelle statt Layout-Tabelle eines Newsletters).
func isSmallCell(n *html.Node) bool {
	length := 0
	var visit func(*html.Node) bool
	visit = func(c *html.Node) bool {
		if c.Type == html.ElementNode && (c.Data == "table" || c.Data == "img") {
			return false
		}
		if c.Type == html.TextNode {
			length += len(strings.TrimSpace(c.Data))
		}
		for k := c.FirstChild; k != nil; k = k.NextSibling {
			if !visit(k) {
				return false
			}
		}
		return length < 200
	}
	return visit(n)
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func (r *htmlRenderer) img(n *html.Node) {
	src := strings.TrimSpace(attr(n, "src"))
	var data []byte
	switch {
	case strings.HasPrefix(strings.ToLower(src), "cid:"):
		if p, ok := r.inline[src[4:]]; ok {
			data = p.Data
		}
	case strings.HasPrefix(src, "data:"):
		if i := strings.Index(src, ";base64,"); i > 0 {
			data, _ = base64.StdEncoding.DecodeString(src[i+8:])
		}
	}
	if data == nil {
		return // externe Bilder werden nicht nachgeladen
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil || cfg.Width*cfg.Height < 400 {
		return // Zählpixel/Abstandhalter überspringen
	}
	if err := r.d.image(data, false); err == nil {
		r.atLineStart, r.blank = true, false
	}
}

func (r *htmlRenderer) walk(n *html.Node) {
	switch n.Type {
	case html.TextNode:
		r.textNode(n.Data)
		return
	case html.ElementNode:
	default:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			r.walk(c)
		}
		return
	}

	tag := n.Data
	if skipTags[tag] {
		return
	}
	switch tag {
	case "br":
		if r.atLineStart {
			r.d.ln(r.size * 0.5)
		} else {
			r.newline()
		}
		return
	case "img":
		r.img(n)
		return
	case "hr":
		r.newline()
		r.d.rule()
		return
	case "td", "th":
		if !r.atLineStart {
			r.d.write("   ", false, r.size)
			r.space = false
		}
	}

	if (tag == "td" || tag == "th") && isSmallCell(n) {
		r.cellDepth++
		defer func() { r.cellDepth-- }()
	}
	if r.cellDepth == 0 || tag == "td" || tag == "th" {
		if paragraphTags[tag] {
			r.paragraph()
		} else if blockTags[tag] {
			r.newline()
		}
	}
	oldSize := r.size
	switch tag {
	case "b", "strong", "th", "h1", "h2", "h3", "h4", "h5", "h6", "dt":
		r.bold++
		defer func() { r.bold-- }()
	case "pre":
		r.pre++
		defer func() { r.pre-- }()
	case "ul":
		r.lists = append(r.lists, 0)
		defer func() { r.lists = r.lists[:len(r.lists)-1] }()
	case "ol":
		r.lists = append(r.lists, 1)
		defer func() { r.lists = r.lists[:len(r.lists)-1] }()
	case "li":
		indent := strings.Repeat("    ", max(len(r.lists)-1, 0))
		bullet := "• "
		if k := len(r.lists) - 1; k >= 0 && r.lists[k] > 0 {
			bullet = fmt.Sprintf("%d. ", r.lists[k])
			r.lists[k]++
		}
		r.d.write(indent+bullet, false, r.size)
		r.atLineStart, r.blank = false, false
	}
	switch tag {
	case "h1":
		r.size = 14
	case "h2":
		r.size = 12.5
	case "h3":
		r.size = 11
	}

	for c := n.FirstChild; c != nil; c = c.NextSibling {
		r.walk(c)
	}
	r.size = oldSize

	if r.cellDepth > 0 && tag != "td" && tag != "th" {
		r.space = r.space || blockTags[tag]
	} else if paragraphTags[tag] {
		r.paragraph()
	} else if blockTags[tag] {
		r.newline()
	}
}
