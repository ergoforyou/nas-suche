package main

import (
	"bytes"
	"errors"
	"fmt"
	"html"
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
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		for _, base := range []string{"/Applications", filepath.Join(home, "Applications")} {
			for _, rel := range []string{
				"Google Chrome.app/Contents/MacOS/Google Chrome",
				"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				"Chromium.app/Contents/MacOS/Chromium",
				"Brave Browser.app/Contents/MacOS/Brave Browser",
			} {
				if p := filepath.Join(base, rel); fileExists(p) {
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

// browserBroken merkt sich, dass Edge auf diesem Rechner nicht druckt –
// dann wird es für den Rest des Laufs nicht mehr versucht (spart Wartezeit).
var browserBroken bool

func htmlToPDF(htmlFile, pdfFile string) error {
	if browserBroken {
		return errors.New("Browser (Edge/Chrome) steht nicht zur Verfügung")
	}
	browser := findBrowser()
	if browser == "" {
		browserBroken = true
		return errors.New("kein Browser (Edge/Chrome) gefunden")
	}
	abs, _ := filepath.Abs(htmlFile)
	fileURL := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(abs), "/")}).String()

	var lastErr error
	for _, mode := range []string{"--headless=new", "--headless"} {
		profile, err := os.MkdirTemp("", "eml2pdf-browser")
		if err != nil {
			return err
		}
		tmpPDF := filepath.Join(profile, "out.pdf")
		args := []string{
			mode, "--disable-gpu", "--no-first-run", "--no-default-browser-check",
			"--disable-extensions", "--disable-sync", "--disable-features=msEdgeSidebarV2,EdgeCollections",
			"--user-data-dir=" + filepath.Join(profile, "profil"), "--no-pdf-header-footer",
			"--print-to-pdf-no-header", "--run-all-compositor-stages-before-draw",
			"--virtual-time-budget=8000", "--print-to-pdf=" + tmpPDF, fileURL,
		}
		if runtime.GOOS != "windows" && os.Geteuid() == 0 {
			args = append([]string{"--no-sandbox"}, args...)
		}
		cmd := exec.Command(browser, args...)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		runErr := runCmd(cmd, 60*time.Second)
		// Edge gibt die Arbeit unter Windows teils an einen Unterprozess ab –
		// deshalb noch bis zu 15 s auf die fertige Datei warten.
		wait := 15 * time.Second
		if runErr != nil {
			wait = 2 * time.Second
		}
		ok := waitForFile(tmpPDF, wait)
		if ok {
			err = copyFile(tmpPDF, pdfFile)
			os.RemoveAll(profile)
			return err
		}
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		lastErr = fmt.Errorf("Edge (%s) erzeugte kein PDF: %v %s", mode, runErr, msg)
		logf("%v", lastErr)
		os.RemoveAll(profile)
	}
	browserBroken = true
	return lastErr
}

// waitForFile wartet, bis die Datei existiert und ihre Größe sich nicht mehr ändert.
func waitForFile(p string, timeout time.Duration) bool {
	var last int64 = -1
	for end := time.Now().Add(timeout); time.Now().Before(end); time.Sleep(300 * time.Millisecond) {
		st, err := os.Stat(p)
		if err != nil || st.Size() == 0 {
			continue
		}
		if st.Size() == last {
			return true
		}
		last = st.Size()
	}
	return false
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

// buildMailHTML baut die HTML-Ansicht der Mail. Eingebettete Bilder werden als Dateien
// in dir abgelegt (das verstehen sowohl Edge als auch Word).
func buildMailHTML(m *Mail, attachmentNames []string, dir string) string {
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
		n := 0
		for cid, p := range m.Inline {
			n++
			name := fmt.Sprintf("bild%d%s", n, sniffExt("", p))
			if os.WriteFile(filepath.Join(dir, name), p.Data, 0o644) != nil {
				continue
			}
			re := regexp.MustCompile(`(?i)cid:` + regexp.QuoteMeta(cid))
			body = re.ReplaceAllLiteralString(body, name)
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

// mailToPDF erzeugt das PDF der E-Mail. Reihenfolge: Edge (schönstes Layout) ->
// Microsoft Word -> eingebauter PDF-Erzeuger (funktioniert immer).
func mailToPDF(m *Mail, names []string, out, tmp string) error {
	dir, err := os.MkdirTemp(tmp, "mail")
	if err != nil {
		return err
	}
	page := filepath.Join(dir, "mail.html")
	if err := os.WriteFile(page, []byte(buildMailHTML(m, names, dir)), 0o644); err != nil {
		return err
	}
	if err := htmlToPDF(page, out); err == nil {
		return nil
	}
	if runtime.GOOS == "windows" {
		if err := msOfficeToPDF(wordScript, page, out); err == nil {
			logf("E-Mail über Word gedruckt")
			return nil
		}
	}
	os.Remove(out)
	logf("E-Mail mit eingebautem PDF-Erzeuger erstellt")
	return builtinMailPDF(m, names, out)
}

// ---------------------------------------------------------------- Anlagen

// convertAttachment wandelt eine Anlage in PDF um. false = Dateityp nicht umwandelbar.
func convertAttachment(src, pdf, tmp string) (bool, error) {
	ext := strings.ToLower(filepath.Ext(src))
	title := filepath.Base(src)
	switch {
	case ext == ".pdf":
		return true, copyFile(src, pdf)
	case imageExt[ext]:
		data, err := os.ReadFile(src)
		if err != nil {
			return true, err
		}
		return true, builtinImagePDF(title, data, pdf)
	case textExt[ext]:
		data, err := os.ReadFile(src)
		if err != nil {
			return true, err
		}
		return true, builtinTextPDF(title, toUTF8(data, ""), pdf)
	case browserExt[ext]:
		if err := htmlToPDF(src, pdf); err == nil {
			return true, nil
		}
		data, err := os.ReadFile(src)
		if err != nil {
			return true, err
		}
		return true, builtinHTMLPDF(title, toUTF8(data, ""), pdf)
	case wordExt[ext] || excelExt[ext] || pptExt[ext]:
		return true, officeToPDF(src, pdf, ext)
	}
	return false, nil
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

// msOfficeToPDF führt eines der Office-Skripte über PowerShell aus.
func msOfficeToPDF(script, src, pdf string) error {
	absSrc, _ := filepath.Abs(src)
	absPDF, _ := filepath.Abs(pdf)
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), "EML_SRC="+absSrc, "EML_DST="+absPDF)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err := runCmd(cmd, 3*time.Minute)
	if err == nil && fileExists(absPDF) {
		return nil
	}
	msg := strings.TrimSpace(stderr.String())
	if len(msg) > 300 {
		msg = msg[:300]
	}
	logf("Microsoft Office konnte %s nicht umwandeln: %v %s", filepath.Base(src), err, msg)
	if err == nil {
		err = errors.New("keine PDF-Datei entstanden")
	}
	return err
}

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
		if err := msOfficeToPDF(script, absSrc, absPDF); err == nil {
			return nil
		}
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
	if soffice == "" && runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		for _, base := range []string{"/Applications", filepath.Join(home, "Applications")} {
			if p := filepath.Join(base, "LibreOffice.app/Contents/MacOS/soffice"); fileExists(p) {
				soffice = p
			}
		}
	}
	if soffice == "" && runtime.GOOS == "windows" {
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if p := filepath.Join(base, `LibreOffice\program\soffice.exe`); base != "" && fileExists(p) {
				soffice = p
			}
		}
	}
	if soffice == "" {
		return errors.New("Word/Excel-Datei: LibreOffice ist nicht installiert (kostenlos unter libreoffice.org)")
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

// ConvertEML wandelt eine .eml-Datei in EIN PDF um: zuerst die E-Mail, dahinter alle Anlagen.
// Anlagen, die sich nicht als PDF darstellen lassen, werden im Original daneben abgelegt.
// Liefert die erzeugten Dateien (das PDF zuerst) und Hinweise für die Abschlussmeldung.
// outDir leer = neben die .eml-Datei.
func ConvertEML(emlPath, outDir string) (created, warnings []string, err error) {
	if outDir == "" {
		outDir = filepath.Dir(emlPath)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, nil, fmt.Errorf("Zielordner nicht verfügbar: %w", err)
	}
	tmp, err := os.MkdirTemp("", "eml2pdf")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(tmp)

	fallback := strings.TrimSuffix(filepath.Base(emlPath), filepath.Ext(emlPath))
	merged, base, extras, warnings, err := convertMail(emlPath, fallback, "", outDir, tmp)
	if err != nil {
		return extras, warnings, err
	}
	final := uniquePath(filepath.Join(outDir, base+".pdf"))
	if err := copyFile(merged, final); err != nil {
		return extras, warnings, err
	}
	logf("Fertig -> %s", final)
	return append([]string{final}, extras...), warnings, nil
}

// convertMail erzeugt das zusammengefügte PDF einer Mail in tmp.
// extras = Dateien, die zusätzlich in outDir abgelegt wurden (nicht umwandelbare Anlagen).
func convertMail(emlPath, fallbackName, prefix, outDir, tmp string) (merged, base string, extras, warnings []string, err error) {
	raw, err := os.ReadFile(emlPath)
	if err != nil {
		return "", "", nil, nil, err
	}
	m, err := ParseMail(raw)
	if err != nil {
		return "", "", nil, nil, err
	}
	base = prefix
	if base == "" {
		subject := m.Subject
		if subject == "" {
			subject = fallbackName
		}
		if !m.Date.IsZero() {
			subject = m.Date.Format("2006-01-02") + " " + subject
		}
		base = safeName(subject, 120)
	}
	work, err := os.MkdirTemp(tmp, "mail")
	if err != nil {
		return "", "", nil, nil, err
	}

	// 1) Anlagen umwandeln
	type converted struct{ pdf, name string }
	var parts []converted
	names := make([]string, len(m.Attachments))
	shown := make([]string, len(m.Attachments)) // für die Kopfzeile "Anlagen:"
	for i, p := range m.Attachments {
		names[i] = AttachmentName(p, i+1)
		shown[i] = names[i]
		name := safeName(names[i], 100)
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		ext := sniffExt(name, p)
		if p.ContentType == "message/rfc822" {
			ext = ".eml"
		}
		src := filepath.Join(work, fmt.Sprintf("quelle%d%s", i+1, ext))
		if err := os.WriteFile(src, p.Data, 0o644); err != nil {
			return "", "", extras, warnings, err
		}
		// Dateiname = Lesezeichen im fertigen PDF
		pdf := filepath.Join(work, fmt.Sprintf("Anlage %d - %s.pdf", i+1, stem))

		var problem error
		if ext == ".eml" {
			sub, err := os.MkdirTemp(tmp, "weitergeleitet")
			if err == nil {
				var inner string
				var innerExtras, innerWarn []string
				inner, _, innerExtras, innerWarn, err = convertMail(src, stem, base+" - Anlage "+stem, outDir, sub)
				extras = append(extras, innerExtras...)
				warnings = append(warnings, innerWarn...)
				if err == nil {
					err = os.Rename(inner, pdf)
				}
			}
			if err == nil {
				parts = append(parts, converted{pdf, names[i]})
				continue
			}
			problem = err
		} else {
			ok, err := convertAttachment(src, pdf, work)
			if ok && err == nil {
				parts = append(parts, converted{pdf, names[i]})
				continue
			}
			os.Remove(pdf)
			problem = err
			if !ok {
				problem = errors.New("Dateityp lässt sich nicht als PDF darstellen")
			}
		}
		// Nicht umwandelbar: Original in den Zielordner, damit nichts verloren geht
		logf("Anlage %s nicht umwandelbar: %v", name, problem)
		orig := uniquePath(filepath.Join(outDir, base+" - Anlage "+name))
		if err := copyFile(src, orig); err != nil {
			return "", "", extras, warnings, err
		}
		extras = append(extras, orig)
		shown[i] += " (separat abgelegt)"
		warnings = append(warnings, fmt.Sprintf("„%s“: %v – liegt separat im Zielordner", names[i], problem))
	}

	// 2) E-Mail selbst
	mailPDF := filepath.Join(work, "E-Mail.pdf")
	if err := mailToPDF(m, shown, mailPDF, work); err != nil {
		return "", "", extras, warnings, err
	}

	// 3) Alles zu einer Datei zusammenfügen
	// Dateinamen ohne ".pdf" werden zu den Lesezeichen im fertigen PDF
	files := []string{strings.TrimSuffix(mailPDF, ".pdf")}
	os.Rename(mailPDF, files[0])
	for i, c := range parts {
		label := strings.TrimSuffix(c.pdf, ".pdf")
		if os.Rename(c.pdf, label) == nil {
			parts[i].pdf = label
		}
		files = append(files, parts[i].pdf)
	}
	merged = filepath.Join(work, "gesamt.pdf")
	for _, i := range mergePDFs(files, merged) {
		// Dieses PDF ließ sich nicht anhängen (z. B. mit Passwort geschützt) -> separat ablegen
		c := parts[i-1]
		out := uniquePath(filepath.Join(outDir, base+" - Anlage "+safeName(strings.TrimSuffix(c.name, filepath.Ext(c.name)), 100)+".pdf"))
		if copyFile(c.pdf, out) == nil {
			extras = append(extras, out)
		}
		warnings = append(warnings, fmt.Sprintf("„%s“ ließ sich nicht anhängen (evtl. geschützt) – liegt separat im Zielordner", c.name))
	}
	return merged, base, extras, warnings, nil
}
