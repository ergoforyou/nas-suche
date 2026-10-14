package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	_ "image/gif"
	_ "image/jpeg"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

var (
	imageExt   = set(".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp")
	textExt    = set(".txt", ".csv", ".log", ".json", ".ics", ".vcf")
	browserExt = set(".htm", ".html", ".svg", ".xml")
	wordExt    = set(".doc", ".docx", ".docm", ".rtf", ".odt")
	excelExt   = set(".xls", ".xlsx", ".xlsm", ".ods")
	pptExt     = set(".ppt", ".pptx", ".odp")
)

func set(v ...string) map[string]bool {
	m := map[string]bool{}
	for _, s := range v {
		m[s] = true
	}
	return m
}

// ---------------------------------------------------------------- Dateinamen

var (
	reColon   = regexp.MustCompile(`:`)
	reSlash   = regexp.MustCompile(`[/\\|]`)
	reInvalid = regexp.MustCompile(`[<>"?*\x00-\x1f]`)
	reSpace   = regexp.MustCompile(`\s+`)
)

func safeName(s string, maxLen int) string {
	s = reColon.ReplaceAllString(s, " -")
	s = reSlash.ReplaceAllString(s, "-")
	s = reInvalid.ReplaceAllString(s, "")
	s = strings.Trim(reSpace.ReplaceAllString(s, " "), " .")
	if r := []rune(s); len(r) > maxLen {
		s = strings.TrimRight(string(r[:maxLen]), " .")
	}
	if s == "" {
		s = "ohne Betreff"
	}
	return s
}

func uniquePath(p string) string {
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for n := 2; ; n++ {
		c := fmt.Sprintf("%s (%d)%s", base, n, ext)
		if _, err := os.Stat(c); os.IsNotExist(err) {
			return c
		}
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ---------------------------------------------------------------- HTML -> PDF über Edge/Chrome

func findBrowser() string {
	if env := os.Getenv("EML2PDF_BROWSER"); env != "" {
		return env
	}
	if runtime.GOOS == "windows" {
		for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
			for _, rel := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`} {
				if p := filepath.Join(base, rel); base != "" && fileExists(p) {
					return p
				}
			}
		}
	}
	for _, name := range []string{"msedge", "google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func htmlToPDF(htmlFile, pdfFile string) error {
	browser := findBrowser()
	if browser == "" {
		return errors.New("Microsoft Edge wurde nicht gefunden")
	}
	profile, err := os.MkdirTemp("", "eml2pdf-browser")
	if err != nil {
		return err
	}
	defer os.RemoveAll(profile)
	tmpPDF := filepath.Join(profile, "out.pdf")
	abs, _ := filepath.Abs(htmlFile)
	fileURL := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(abs), "/")}).String()
	args := []string{
		"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--user-data-dir=" + profile, "--no-pdf-header-footer",
		"--run-all-compositor-stages-before-draw", "--virtual-time-budget=10000",
		"--print-to-pdf=" + tmpPDF, fileURL,
	}
	if runtime.GOOS != "windows" && os.Geteuid() == 0 {
		args = append([]string{"--no-sandbox"}, args...)
	}
	if err := runHidden(2*time.Minute, browser, args...); err != nil && !fileExists(tmpPDF) {
		return fmt.Errorf("PDF-Druck fehlgeschlagen: %w", err)
	}
	if st, err := os.Stat(tmpPDF); err != nil || st.Size() == 0 {
		return errors.New("Edge konnte kein PDF erzeugen")
	}
	return copyFile(tmpPDF, pdfFile)
}

func runHidden(timeout time.Duration, name string, args ...string) error {
	return runCmd(exec.Command(name, args...), timeout)
}

func runCmd(cmd *exec.Cmd, timeout time.Duration) error {
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		cmd.Process.Kill()
		return errors.New("Zeitüberschreitung")
	}
}

// ---------------------------------------------------------------- E-Mail als HTML

const mailCSS = `
@page { size: A4; margin: 15mm; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #000; }
.kopf { border-bottom: 2px solid #444; margin-bottom: 14px; padding-bottom: 8px; }
.kopf h1 { font-size: 15pt; margin: 0 0 8px 0; }
.kopf table { border-collapse: collapse; font-size: 10pt; }
.kopf td { padding: 1px 10px 1px 0; vertical-align: top; }
.kopf td.l { font-weight: bold; white-space: nowrap; }
pre.text { white-space: pre-wrap; word-wrap: break-word; font-family: Consolas, monospace; font-size: 10pt; }
.inhalt img { max-width: 100%; height: auto; }
.inhalt table { max-width: 100% !important; }
`

var reStripTags = regexp.MustCompile(`(?is)<!DOCTYPE[^>]*>|</?html[^>]*>|</?body[^>]*>|<meta[^>]*>`)

func dataURI(ctype string, data []byte) string {
	return "data:" + ctype + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func buildMailHTML(m *Mail, attachmentNames []string) string {
	esc := html.EscapeString
	type row struct{ k, v string }
	rows := []row{{"Von", esc(m.From)}, {"An", esc(m.To)}}
	if m.Cc != "" {
		rows = append(rows, row{"Cc", esc(m.Cc)})
	}
	if !m.Date.IsZero() {
		rows = append(rows, row{"Datum", m.Date.Format("02.01.2006 15:04")})
	}
	if len(attachmentNames) > 0 {
		rows = append(rows, row{"Anlagen", esc(strings.Join(attachmentNames, ", "))})
	}
	var head strings.Builder
	for _, r := range rows {
		fmt.Fprintf(&head, `<tr><td class="l">%s:</td><td>%s</td></tr>`, r.k, r.v)
	}

	var content string
	if m.HTML != "" {
		body := m.HTML
		for cid, p := range m.Inline {
			re := regexp.MustCompile(`(?i)cid:` + regexp.QuoteMeta(cid))
			uri := dataURI(p.ContentType, p.Data)
			body = re.ReplaceAllLiteralString(body, uri)
		}
		content = `<div class="inhalt">` + reStripTags.ReplaceAllString(body, "") + `</div>`
	} else {
		content = `<pre class="text">` + esc(m.Text) + `</pre>`
	}
	subject := m.Subject
	if subject == "" {
		subject = "(ohne Betreff)"
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>` + esc(subject) +
		`</title><style>` + mailCSS + `</style></head><body><div class="kopf"><h1>` + esc(subject) +
		`</h1><table>` + head.String() + `</table></div>` + content + `</body></html>`
}

// ---------------------------------------------------------------- Anlagen

// convertAttachment wandelt eine Anlage in PDF um. false = Dateityp nicht umwandelbar.
func convertAttachment(src, pdf, tmp string) (bool, error) {
	ext := strings.ToLower(filepath.Ext(src))
	switch {
	case ext == ".pdf":
		return true, copyFile(src, pdf)
	case imageExt[ext]:
		return true, imageToPDF(src, pdf, tmp)
	case textExt[ext]:
		data, err := os.ReadFile(src)
		if err != nil {
			return true, err
		}
		page := `<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:15mm}` +
			`pre{white-space:pre-wrap;word-wrap:break-word;font:10pt Consolas,monospace}</style></head><body><pre>` +
			html.EscapeString(toUTF8(data, "")) + `</pre></body></html>`
		return true, printHTMLString(page, pdf, tmp)
	case browserExt[ext]:
		return true, htmlToPDF(src, pdf)
	case wordExt[ext] || excelExt[ext] || pptExt[ext]:
		return true, officeToPDF(src, pdf, ext)
	}
	return false, nil
}

func printHTMLString(page, pdf, tmp string) error {
	f, err := os.CreateTemp(tmp, "seite-*.html")
	if err != nil {
		return err
	}
	f.WriteString(page)
	f.Close()
	return htmlToPDF(f.Name(), pdf)
}

func imageToPDF(src, pdf, tmp string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	ctype := map[string]string{".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
		".gif": "image/gif", ".webp": "image/webp"}[strings.ToLower(filepath.Ext(src))]
	if ctype == "" { // TIFF/BMP kann der Browser nicht anzeigen -> nach PNG umwandeln
		img, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("Bild nicht lesbar: %w", err)
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return err
		}
		data, ctype = buf.Bytes(), "image/png"
	}
	page := `<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:10mm}` +
		`html,body{margin:0;height:100%}img{display:block;margin:0 auto;max-width:100%;max-height:270mm;object-fit:contain}` +
		`</style></head><body><img src="` + dataURI(ctype, data) + `"></body></html>`
	return printHTMLString(page, pdf, tmp)
}

// Office-Skripte: Makros aus, keine Rückfragen, Passwortschutz führt zu Fehler statt Eingabefenster.
const (
	wordScript = `$ErrorActionPreference='Stop';$a=New-Object -ComObject Word.Application;` +
		`try{$a.Visible=$false;$a.DisplayAlerts=0;$a.AutomationSecurity=3;$m=[Type]::Missing;` +
		`$d=$a.Documents.Open($env:EML_SRC,$false,$true,$false,'#','#',$true,'#','#',0,$m,$false,$true,$m,$true);` +
		`$d.ExportAsFixedFormat($env:EML_DST,17);$d.Close(0)}finally{$a.Quit(0)}`
	excelScript = `$ErrorActionPreference='Stop';$a=New-Object -ComObject Excel.Application;` +
		`try{$a.Visible=$false;$a.DisplayAlerts=$false;$a.AskToUpdateLinks=$false;$a.AutomationSecurity=3;$m=[Type]::Missing;` +
		`$b=$a.Workbooks.Open($env:EML_SRC,0,$true,$m,'#','#',$true);` +
		`$b.ExportAsFixedFormat(0,$env:EML_DST);$b.Close($false)}finally{$a.Quit()}`
	// PowerPoint läuft nur einmal pro Benutzer – nur beenden, wenn wir es selbst gestartet haben.
	pptScript = `$ErrorActionPreference='Stop';$a=New-Object -ComObject PowerPoint.Application;$n=$a.Presentations.Count;` +
		`try{$a.AutomationSecurity=3;$p=$a.Presentations.Open($env:EML_SRC,-1,0,0);$p.SaveAs($env:EML_DST,32);$p.Close()}` +
		`finally{if($n -eq 0){$a.Quit()}}`
)

// officeToPDF nutzt Microsoft Office (über PowerShell), sonst LibreOffice.
func officeToPDF(src, pdf, ext string) error {
	absSrc, _ := filepath.Abs(src)
	absPDF, _ := filepath.Abs(pdf)
	if runtime.GOOS == "windows" {
		script := pptScript
		if wordExt[ext] {
			script = wordScript
		} else if excelExt[ext] {
			script = excelScript
		}
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
		cmd.Env = append(os.Environ(), "EML_SRC="+absSrc, "EML_DST="+absPDF)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		err := runCmd(cmd, 3*time.Minute)
		if err == nil && fileExists(absPDF) {
			return nil
		}
		logf("Microsoft Office konnte %s nicht umwandeln (%v %s), versuche LibreOffice",
			filepath.Base(src), err, strings.TrimSpace(stderr.String()))
	}
	if err := libreOfficeToPDF(absSrc, absPDF); err != nil {
		if runtime.GOOS == "windows" {
			return errors.New("Office konnte die Datei nicht öffnen (evtl. passwortgeschützt oder beschädigt)")
		}
		return err
	}
	return nil
}

func libreOfficeToPDF(src, pdf string) error {
	soffice, _ := exec.LookPath("soffice")
	if soffice == "" && runtime.GOOS == "windows" {
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if p := filepath.Join(base, `LibreOffice\program\soffice.exe`); base != "" && fileExists(p) {
				soffice = p
			}
		}
	}
	if soffice == "" {
		return errors.New("weder Microsoft Office noch LibreOffice gefunden")
	}
	out, err := os.MkdirTemp("", "eml2pdf-lo")
	if err != nil {
		return err
	}
	defer os.RemoveAll(out)
	profile := "file:///" + strings.TrimPrefix(filepath.ToSlash(filepath.Join(out, "profil")), "/")
	runHidden(3*time.Minute, soffice, "-env:UserInstallation="+profile, "--headless",
		"--convert-to", "pdf", "--outdir", out, src)
	produced := filepath.Join(out, strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))+".pdf")
	if !fileExists(produced) {
		return errors.New("LibreOffice konnte die Datei nicht umwandeln")
	}
	return copyFile(produced, pdf)
}

// ---------------------------------------------------------------- Hauptfunktion

// sniffExt ermittelt die Dateiendung am Inhalt, wenn der Name keine brauchbare hat.
func sniffExt(name string, p Part) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".pdf" || ext == ".eml" || imageExt[ext] || textExt[ext] || browserExt[ext] ||
		wordExt[ext] || excelExt[ext] || pptExt[ext] {
		return ext
	}
	head := p.Data
	if len(head) > 1024 {
		head = head[:1024]
	}
	if bytes.Contains(head, []byte("%PDF-")) {
		return ".pdf"
	}
	byType := map[string]string{
		"application/pdf":    ".pdf",
		"application/msword": ".doc",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
		"application/vnd.ms-excel": ".xls",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         ".xlsx",
		"application/vnd.ms-powerpoint":                                             ".ppt",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
		"application/rtf": ".rtf", "text/rtf": ".rtf",
	}
	if e, ok := byType[strings.ToLower(p.ContentType)]; ok {
		return e
	}
	switch http.DetectContentType(head) {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/bmp":
		return ".bmp"
	case "image/webp":
		return ".webp"
	}
	if bytes.HasPrefix(head, []byte("{\\rtf")) {
		return ".rtf"
	}
	return ext
}

// ConvertEML wandelt eine .eml-Datei samt Anlagen um.
// Liefert die erzeugten Dateien und Hinweise zu Anlagen, die nicht umgewandelt werden konnten.
// outDir leer = neben die .eml-Datei.
func ConvertEML(emlPath, outDir, prefix string) (created, warnings []string, err error) {
	raw, err := os.ReadFile(emlPath)
	if err != nil {
		return nil, nil, err
	}
	m, err := ParseMail(raw)
	if err != nil {
		return nil, nil, err
	}
	if outDir == "" {
		outDir = filepath.Dir(emlPath)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, nil, err
	}

	names := make([]string, len(m.Attachments))
	for i, p := range m.Attachments {
		names[i] = AttachmentName(p, i+1)
	}
	base := prefix
	if base == "" {
		subject := m.Subject
		if subject == "" {
			subject = strings.TrimSuffix(filepath.Base(emlPath), filepath.Ext(emlPath))
		}
		if !m.Date.IsZero() {
			subject = m.Date.Format("2006-01-02") + " " + subject
		}
		base = safeName(subject, 120)
	}

	tmp, err := os.MkdirTemp("", "eml2pdf")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(tmp)

	mailPDF := uniquePath(filepath.Join(outDir, base+".pdf"))
	if err := printHTMLString(buildMailHTML(m, names), mailPDF, tmp); err != nil {
		return nil, nil, err
	}
	created = append(created, mailPDF)
	logf("E-Mail -> %s", mailPDF)

	for i, p := range m.Attachments {
		name := safeName(names[i], 100)
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		ext := sniffExt(name, p)
		if p.ContentType == "message/rfc822" {
			ext = ".eml"
		}
		src := filepath.Join(tmp, fmt.Sprintf("anlage%d%s", i+1, ext))
		if err := os.WriteFile(src, p.Data, 0o644); err != nil {
			return created, warnings, err
		}
		label := base + " - Anlage " + stem

		var problem error
		if ext == ".eml" {
			inner, innerWarn, err := ConvertEML(src, outDir, safeName(label, 150))
			created = append(created, inner...)
			warnings = append(warnings, innerWarn...)
			if err == nil {
				continue
			}
			problem = err
		} else {
			pdf := uniquePath(filepath.Join(outDir, label+".pdf"))
			ok, err := convertAttachment(src, pdf, tmp)
			if ok && err == nil {
				created = append(created, pdf)
				logf("Anlage -> %s", pdf)
				continue
			}
			os.Remove(pdf)
			problem = err
			if !ok {
				problem = errors.New("Dateityp lässt sich nicht in PDF umwandeln")
			}
		}
		// Nicht umwandelbar: Original danebenlegen, damit nichts verloren geht
		logf("Anlage %s nicht umwandelbar: %v", name, problem)
		orig := uniquePath(filepath.Join(outDir, base+" - Anlage "+name))
		if err := copyFile(src, orig); err != nil {
			return created, warnings, err
		}
		created = append(created, orig)
		warnings = append(warnings, fmt.Sprintf("„%s“: %v – Original abgelegt", names[i], problem))
	}
	return created, warnings, nil
}
