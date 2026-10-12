//go:build !windows

package main

// Mac-Version (läuft auch unter Linux zum Testen): gleiche Suche, eigene Oberfläche.

import (
	_ "embed"
	"fmt"
	"image/color"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

//go:embed icon.png
var iconPNG []byte

//go:embed assets/Montserrat-SemiBold.ttf
var macFontSemiBold []byte

const (
	brandName    = "ERGOFORYOU"
	brandProduct = "NAS-Suche"
	brandSlogan  = "Wenn es schnell gehen muss."
)

const maxResults = 100000

type MacApp struct {
	fa        fyne.App
	w         fyne.Window
	cfg       *Config
	ix        *Index
	panes     [2]*MPane
	paneBox   *fyne.Container
	status    *widget.Label
	secondBtn *widget.Button
	refreshBt *widget.Button

	indexing  bool
	stopIndex atomic.Bool
	lastInfo  string
	sticky    time.Time

	optionDown bool       // ⌥ gedrückt = kopieren statt verschieben
	drag       *dragState // laufendes Ziehen innerhalb des Programms
}

type dragState struct {
	src    *MPane
	paths  []string
	target *MPane
	pos    fyne.Position
}

func main() {
	a := &MacApp{cfg: LoadConfig()}
	a.run()
}

func (a *MacApp) run() {
	a.fa = app.NewWithID("de.ergoforyou.nassuche")
	a.fa.SetIcon(fyne.NewStaticResource("icon.png", iconPNG))
	a.fa.Settings().SetTheme(&brandTheme{})
	a.w = a.fa.NewWindow(brandName + " " + brandProduct)
	a.w.Resize(fyne.NewSize(1300, 780))

	a.status = widget.NewLabel("Lade Index …")
	a.status.Truncation = fyne.TextTruncateEllipsis
	a.panes = [2]*MPane{newMPane(a, 0), newMPane(a, 1)}

	a.secondBtn = widget.NewButton("Zweite Ansicht einblenden", func() { a.setSecondPane(!a.cfg.SecondPane) })
	a.refreshBt = widget.NewButton("Aktualisieren", a.toggleIndex)
	settingsBt := widget.NewButton("Einstellungen …", a.showSettings)
	topBar := container.NewHBox(layout.NewSpacer(), a.secondBtn, a.refreshBt, settingsBt)

	a.paneBox = container.NewGridWithColumns(1, a.panes[0].root)
	tip := canvas.NewText("Tipp: Doppelklick auf Ordner zeigt den Inhalt. Dateien in die andere Ansicht ziehen = verschieben (⌥ gedrückt = kopieren). Rechtsklick für mehr.", color.Gray{Y: 0x70})
	tip.TextSize = 11
	bottom := container.NewVBox(tip, a.status)
	content := container.NewBorder(container.NewVBox(a.banner(), container.NewPadded(topBar)), bottom, nil, nil, container.NewPadded(a.paneBox))
	a.w.SetContent(content)

	// ⌥ (Option) beim Ziehen = kopieren
	if dc, ok := a.w.Canvas().(desktop.Canvas); ok {
		dc.SetOnKeyDown(func(ev *fyne.KeyEvent) {
			if ev.Name == desktop.KeyAltLeft || ev.Name == desktop.KeyAltRight {
				a.optionDown = true
			}
		})
		dc.SetOnKeyUp(func(ev *fyne.KeyEvent) {
			if ev.Name == desktop.KeyAltLeft || ev.Name == desktop.KeyAltRight {
				a.optionDown = false
			}
		})
	}
	// Dateien aus dem Finder ins Fenster ziehen
	a.w.SetOnDropped(a.droppedFromFinder)

	// Menüleisten-Symbol: Programm läuft weiter, wenn das Fenster geschlossen wird
	if desk, ok := a.fa.(desktop.App); ok {
		desk.SetSystemTrayMenu(fyne.NewMenu(brandProduct,
			fyne.NewMenuItem("Suche öffnen", func() { a.w.Show(); a.w.RequestFocus() }),
			fyne.NewMenuItem("Index aktualisieren", a.toggleIndex),
		))
		a.w.SetCloseIntercept(func() { a.w.Hide() })
	}

	a.setSecondPane(a.cfg.SecondPane)
	go a.startup()
	a.w.Show()
	a.w.Canvas().Focus(a.panes[0].search)
	a.fa.Run()
	a.stopIndex.Store(true)
}

func (a *MacApp) banner() fyne.CanvasObject {
	bg := canvas.NewHorizontalGradient(color.NRGBA{0x10, 0x2A, 0x43, 0xFF}, color.NRGBA{0x1F, 0x6F, 0xB2, 0xFF})
	accent := canvas.NewRectangle(color.NRGBA{0xFF, 0xBE, 0x28, 0xFF})
	accent.SetMinSize(fyne.NewSize(6, 60))
	name := canvas.NewText(brandName, color.White)
	name.TextSize = 26
	name.TextStyle = fyne.TextStyle{Bold: true}
	prod := canvas.NewText(brandProduct, color.White)
	prod.TextSize = 13
	slogan := canvas.NewText(brandSlogan, color.NRGBA{0xFF, 0xD7, 0x7A, 0xFF})
	slogan.TextSize = 13
	texts := container.NewHBox(accent, widget.NewLabel(" "), container.NewCenter(name), widget.NewLabel(" "),
		container.NewCenter(container.NewVBox(prod, slogan)))
	b := container.NewStack(bg, texts)
	return b
}

func (a *MacApp) setStatus(s string) {
	a.status.SetText(s)
}

// paneStatus: Meldungen der Ansichten, außer eine wichtige Meldung soll kurz stehen bleiben.
func (a *MacApp) paneStatus(s string) {
	if time.Now().Before(a.sticky) {
		return
	}
	a.setStatus(s)
}

func (a *MacApp) setSecondPane(on bool) {
	changed := on != a.cfg.SecondPane
	a.cfg.SecondPane = on
	if on {
		a.paneBox.Layout = layout.NewGridLayoutWithColumns(2)
		a.paneBox.Objects = []fyne.CanvasObject{a.panes[0].root, a.panes[1].root}
		a.secondBtn.SetText("Zweite Ansicht ausblenden")
		a.panes[1].scheduleSearch()
	} else {
		a.paneBox.Layout = layout.NewGridLayoutWithColumns(1)
		a.paneBox.Objects = []fyne.CanvasObject{a.panes[0].root}
		a.secondBtn.SetText("Zweite Ansicht einblenden")
	}
	a.paneBox.Refresh()
	if changed {
		a.cfg.Save()
	}
}

// ---------- Start, Netzlaufwerke, Index ----------

func (a *MacApp) startup() {
	ix, _ := LoadIndex(indexPath())
	a.ix = ix
	a.updateInfo()
	for _, p := range a.panes {
		p.scheduleSearch()
	}
	if len(a.cfg.Folders) == 0 {
		a.setStatus("Bitte unter „Einstellungen …“ festlegen, welche Ordner durchsucht werden (z. B. /Volumes/Daten).")
		a.showSettings()
		return
	}
	a.mountShares()
	a.openStartFolders()
	a.maintain()
	for range time.Tick(5 * time.Minute) {
		a.maintain()
	}
}

// smbURL wandelt \\Server\Freigabe oder smb://Server/Freigabe in eine smb-Adresse.
func smbURL(remote string) string {
	r := strings.TrimSpace(remote)
	if strings.HasPrefix(strings.ToLower(r), "smb://") {
		return r
	}
	r = strings.TrimLeft(strings.ReplaceAll(r, `\`, "/"), "/")
	if r == "" {
		return ""
	}
	return "smb://" + r
}

// mountShares verbindet die eingetragenen NAS-Freigaben (macOS fragt einmal nach dem Kennwort
// und bietet an, es im Schlüsselbund zu sichern).
func (a *MacApp) mountShares() {
	if runtime.GOOS != "darwin" {
		return
	}
	for _, d := range a.cfg.Drives {
		u := smbURL(d.Remote)
		if u == "" {
			continue
		}
		share := u[strings.LastIndex(u, "/")+1:]
		if _, err := os.Stat(filepath.Join("/Volumes", share)); err == nil {
			continue
		}
		exec.Command("osascript", "-e", `mount volume "`+u+`"`).Run()
	}
}

func (a *MacApp) openStartFolders() {
	if sf := a.cfg.StartFolder; sf != "" {
		a.panes[0].openFolder(sf)
	}
	if sf := a.cfg.StartFolder2; sf != "" && a.cfg.SecondPane {
		a.panes[1].openFolder(sf)
	}
}

func (a *MacApp) maintain() {
	if a.indexing {
		return
	}
	stale := a.ix == nil || !sameRoots(a.ix.Roots, a.cfg.Folders) ||
		(a.cfg.RefreshHours > 0 && time.Since(a.ix.Built) > time.Duration(a.cfg.RefreshHours)*time.Hour)
	if stale && len(a.cfg.Folders) > 0 {
		a.startIndex()
	}
}

func sameRoots(x, y []string) bool {
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if !strings.EqualFold(strings.TrimSpace(x[i]), strings.TrimSpace(y[i])) {
			return false
		}
	}
	return true
}

func (a *MacApp) updateInfo() {
	if a.ix == nil {
		a.lastInfo = "Noch kein Index vorhanden."
	} else {
		a.lastInfo = fmt.Sprintf("Index: %s Einträge, Stand %s", thousands(int64(len(a.ix.Entries))),
			a.ix.Built.Format("02.01.2006 15:04"))
		if a.ix.Errors > 0 {
			a.lastInfo += fmt.Sprintf(" (%d Ordner nicht lesbar)", a.ix.Errors)
		}
	}
	if !a.indexing {
		a.paneStatus(a.lastInfo)
	}
}

func (a *MacApp) toggleIndex() {
	if a.indexing {
		a.stopIndex.Store(true)
		a.setStatus("Breche ab …")
		return
	}
	if len(a.cfg.Folders) == 0 {
		a.showSettings()
		return
	}
	a.startIndex()
}

func (a *MacApp) startIndex() {
	if a.indexing {
		return
	}
	a.indexing = true
	a.stopIndex.Store(false)
	a.refreshBt.SetText("Abbrechen")
	folders := append([]string(nil), a.cfg.Folders...)
	excludes := append([]string(nil), a.cfg.Excludes...)
	p := &Progress{}
	p.Current.Store("")
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(400 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				cur, _ := p.Current.Load().(string)
				a.setStatus(fmt.Sprintf("Lese Ordner ein … %s Einträge in %s Ordnern – %s",
					thousands(p.Files.Load()), thousands(p.Folders.Load()), cur))
			}
		}
	}()
	go func() {
		start := time.Now()
		ix := BuildIndex(folders, excludes, a.cfg.Workers, &a.stopIndex, p)
		close(done)
		cancelled := a.stopIndex.Load()
		if !cancelled {
			SaveIndex(ix, indexPath())
			a.ix = ix
		}
		a.indexing = false
		a.refreshBt.SetText("Aktualisieren")
		a.updateInfo()
		if !cancelled {
			a.setStatus(fmt.Sprintf("%s (eingelesen in %s)", a.lastInfo, time.Since(start).Round(time.Second)))
			for _, p := range a.panes {
				p.scheduleSearch()
			}
		}
	}()
}

// ---------- Verschieben / Kopieren ----------

// transfer verschiebt oder kopiert Dateien/Ordner in den Zielordner (im Hintergrund).
func (a *MacApp) transfer(paths []string, target string, move bool) {
	var todo []string
	for _, s := range paths {
		if filepath.Dir(s) == target || s == target || strings.HasPrefix(target, s+string(os.PathSeparator)) {
			continue
		}
		todo = append(todo, s)
	}
	if len(todo) == 0 {
		return
	}
	verb := map[bool]string{true: "Verschiebe", false: "Kopiere"}[move]
	a.setStatus(fmt.Sprintf("%s %d Element(e) nach %s …", verb, len(todo), target))
	go func() {
		moves := map[string]string{}
		var failed []string
		for _, s := range todo {
			dst := uniqueTarget(filepath.Join(target, filepath.Base(s)))
			var err error
			if move {
				err = moveItem(s, dst)
				if err == nil {
					moves[s] = dst
				}
			} else {
				err = copyItem(s, dst)
			}
			if err != nil {
				failed = append(failed, filepath.Base(s)+": "+err.Error())
			}
		}
		if len(moves) > 0 && a.ix != nil {
			a.ix = a.ix.WithMoves(moves)
		}
		for _, p := range a.panes {
			p.scheduleSearch()
		}
		msg := fmt.Sprintf("%d Element(e) nach %s %s.", len(todo)-len(failed), target,
			map[bool]string{true: "verschoben", false: "kopiert"}[move])
		if len(failed) > 0 {
			msg += " Fehler: " + strings.Join(failed, "; ")
		}
		a.setStatus(msg)
		a.sticky = time.Now().Add(4 * time.Second)
	}()
}

// uniqueTarget hängt bei Namensgleichheit „ (2)“, „ (3)“ … an, statt zu überschreiben.
func uniqueTarget(p string) string {
	if _, err := os.Lstat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Lstat(c); err != nil {
			return c
		}
	}
}

func moveItem(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// anderes Laufwerk/Freigabe: kopieren, dann Original entfernen
	if err := copyItem(src, dst); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

func copyItem(src, dst string) error {
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return copyPlainFile(src, dst, fi.Mode())
	}
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(t, 0o755)
		}
		return copyPlainFile(p, t, info.Mode())
	})
}

func copyPlainFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm()|0o600)
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if fi, err := in.Stat(); err == nil {
		defer os.Chtimes(dst, fi.ModTime(), fi.ModTime())
	}
	return out.Close()
}

// droppedFromFinder: Dateien aus dem Finder auf eine Ansicht gezogen.
func (a *MacApp) droppedFromFinder(pos fyne.Position, uris []fyne.URI) {
	var paths []string
	for _, u := range uris {
		if u.Scheme() == "file" {
			paths = append(paths, u.Path())
		}
	}
	if len(paths) == 0 {
		return
	}
	p := a.paneAt(pos, true)
	if p == nil || p.dropFolder() == "" {
		a.setStatus("Zum Ablegen erst in einer Ansicht einen Ordner öffnen (Doppelklick).")
		return
	}
	a.transfer(paths, p.dropFolder(), !a.optionDown)
}

// paneAt: welche Ansicht liegt unter der Position (Fensterkoordinaten)?
func (a *MacApp) paneAt(pos fyne.Position, windowCoords bool) *MPane {
	for _, p := range a.panes {
		if p.idx == 1 && !a.cfg.SecondPane {
			continue
		}
		drv := a.fa.Driver()
		tp := drv.AbsolutePositionForObject(p.root)
		sz := p.root.Size()
		if pos.X >= tp.X && pos.X <= tp.X+sz.Width && pos.Y >= tp.Y && pos.Y <= tp.Y+sz.Height {
			return p
		}
	}
	return nil
}

func openPath(p string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", p).Start()
	} else {
		exec.Command("xdg-open", p).Start()
	}
}

func revealPath(p string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", "-R", p).Start()
	} else {
		exec.Command("xdg-open", filepath.Dir(p)).Start()
	}
}

// copyFileToClipboard legt die Datei selbst in die Zwischenablage (Einfügen im Finder, in Mail …).
func copyFileToClipboard(p string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("nur auf dem Mac")
	}
	return exec.Command("osascript", "-e", `set the clipboard to (POSIX file "`+strings.ReplaceAll(p, `"`, `\"`)+`")`).Run()
}

// ---------- Darstellung ----------

type brandTheme struct{}

var montserrat = fyne.NewStaticResource("Montserrat-SemiBold.ttf", macFontSemiBold)

func (brandTheme) Color(n fyne.ThemeColorName, v fyne.ThemeVariant) color.Color {
	return theme.DefaultTheme().Color(n, theme.VariantLight)
}
func (brandTheme) Font(s fyne.TextStyle) fyne.Resource {
	if s.Bold && !s.Monospace && !s.Italic {
		return montserrat
	}
	return theme.DefaultTheme().Font(s)
}
func (brandTheme) Icon(n fyne.ThemeIconName) fyne.Resource { return theme.DefaultTheme().Icon(n) }
func (brandTheme) Size(n fyne.ThemeSizeName) float32 {
	if n == theme.SizeNameText {
		return 13
	}
	return theme.DefaultTheme().Size(n)
}
