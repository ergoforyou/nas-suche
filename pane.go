//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
)

// Pane ist eine Suchhälfte: Suchfeld, Haken, Trefferliste – oder der Inhalt eines Ordners.
type Pane struct {
	app           *App
	idx           int // 0 = links, 1 = rechts
	root          *walk.Composite
	search        *walk.LineEdit
	inPath        *walk.CheckBox
	filterBtns    [CatFolder + 1]*walk.CheckBox // Index = Kategorie, 0 unbenutzt
	pathBar       *walk.Composite
	pathLabel     *walk.Label
	crumbs        *walk.Composite // Pfad als anklickbare Teilstücke mit Unterordner-Auswahl
	crumbSlots    []*crumbSlot
	crumbMore     *walk.PushButton
	crumbMorePath string
	tv            *walk.TableView
	copyMenu      *walk.Menu
	model         *ResultModel

	filter    *uint8 // zeigt in die Einstellungen (links/rechts getrennt)
	inPathCfg *bool
	sortCol   *int
	sortDesc  *bool

	dropRow    int // beim Ziehen hervorgehobene Ordnerzeile (-1 = keine)
	hoverRow   int // Ordnerzeile, über der beim Ziehen verweilt wird
	hoverAt    time.Time
	noSubs     map[string]bool // Ordner ohne Unterordner (nicht erneut lesen)
	lastScroll time.Time
	dropWhole  bool // ganzer geöffneter Ordner ist Ziel

	searchGen atomic.Int64
	debounce  *time.Timer

	dragArmed  bool
	dragX      int
	dragY      int
	dropStatus string
}

func newPane(a *App, idx int) *Pane {
	p := &Pane{app: a, idx: idx, model: &ResultModel{sortCol: 0, asc: true}}
	p.dropRow, p.hoverRow = -1, -1
	p.noSubs = map[string]bool{}
	if idx == 0 {
		p.filter, p.inPathCfg = &a.cfg.Filter, &a.cfg.InPath
		p.sortCol, p.sortDesc = &a.cfg.SortCol, &a.cfg.SortDesc
	} else {
		p.filter, p.inPathCfg = &a.cfg.Filter2, &a.cfg.InPath2
		p.sortCol, p.sortDesc = &a.cfg.SortCol2, &a.cfg.SortDesc2
	}
	return p
}

func (p *Pane) other() *Pane { return p.app.panes[1-p.idx] }

func (p *Pane) widget() Widget {
	grey := walk.RGB(0x60, 0x6B, 0x78)
	var filters []Widget
	for c := CatPDF; c <= CatFolder; c++ {
		filters = append(filters, CheckBox{
			AssignTo:         &p.filterBtns[c],
			Text:             CatNames[c],
			Checked:          *p.filter&FilterBit(c) != 0,
			MinSize:          Size{Width: 90},
			OnCheckedChanged: p.filterChanged,
		})
	}
	cue := "Suchen …  z. B.  angebot müller *.pdf"
	if p.idx == 1 {
		cue = "Zweite Suche …  z. B. Zielordner suchen und doppelklicken"
	}
	return Composite{
		AssignTo:      &p.root,
		StretchFactor: 1,
		Layout:        VBox{MarginsZero: true, Spacing: 4},
		Children: []Widget{
			Composite{
				Layout:  HBox{MarginsZero: true},
				MaxSize: Size{Height: 34},
				Children: []Widget{
					LineEdit{
						AssignTo:      &p.search,
						CueBanner:     cue,
						Font:          Font{Family: "Segoe UI", PointSize: 12},
						OnTextChanged: p.searchTextChanged,
						OnKeyDown:     p.searchKey,
					},
					CheckBox{
						AssignTo:  &p.inPath,
						Text:      "Auch im Ordnerpfad",
						Checked:   *p.inPathCfg,
						OnClicked: func() { *p.inPathCfg = p.inPath.Checked(); p.app.cfg.Save(); p.scheduleSearch() },
					},
				},
			},
			Composite{
				Layout:  HBox{MarginsZero: true, Spacing: 10},
				MaxSize: Size{Height: 26},
				Children: append(append([]Widget{Label{Text: "Nur anzeigen:"}}, filters...),
					Label{Text: "(kein Haken = alles)", TextColor: grey}, HSpacer{}),
			},
			Composite{
				AssignTo: &p.pathBar,
				Visible:  false,
				Layout:   HBox{MarginsZero: true},
				MaxSize:  Size{Height: 30},
				Children: []Widget{
					PushButton{Text: "↑ Nach oben", OnClicked: p.goUp},
					Composite{AssignTo: &p.crumbs, Layout: HBox{MarginsZero: true, Spacing: 0}},
					Label{AssignTo: &p.pathLabel, Font: Font{Family: "Segoe UI", PointSize: 10, Bold: true}, TextColor: walk.RGB(0x00, 0x3E, 0x8A)},
					HSpacer{},
					PushButton{Text: "Im Explorer", OnClicked: func() { openExplorer(p.model.folder, false) }},
					PushButton{Text: "× Zurück zur Suche", OnClicked: p.backToSearch},
				},
			},
			TableView{
				AssignTo:         &p.tv,
				StretchFactor:    1000,
				AlternatingRowBG: true,
				MultiSelection:   true,
				Columns: []TableViewColumn{
					{Title: "Name", Width: 260},
					{Title: "Typ", Width: 85},
					{Title: "Ordner", Width: 250},
					{Title: "Größe", Width: 70, Alignment: AlignFar},
					{Title: "Geändert", Width: 105},
				},
				Model:           p.model,
				StyleCell:       p.styleCell,
				OnItemActivated: p.activate,
				ContextMenuItems: []MenuItem{
					Action{Text: "Öffnen\tEnter", OnTriggered: p.activate},
					Action{Text: "In der anderen Ansicht öffnen", OnTriggered: p.openInOther},
					Action{Text: "Im Explorer anzeigen", OnTriggered: p.showInFolder},
					Separator{},
					Action{Text: "Kopieren (Dateien)\tStrg+C", OnTriggered: p.copyFiles},
					Menu{AssignTo: &p.copyMenu, Text: "Kopieren nach", Items: []MenuItem{
						Action{Text: "Ordner auswählen …"},
					}},
					Separator{},
					Action{Text: "Pfad kopieren\tStrg+Umschalt+C", OnTriggered: func() { p.copyText(true) }},
					Action{Text: "Name kopieren", OnTriggered: func() { p.copyText(false) }},
				},
			},
		},
	}
}

// init wird nach dem Erzeugen des Fensters aufgerufen.
func (p *Pane) init() {
	p.model.onReset = func() { p.tv.Invalidate() }
	onlyNameIcons(p.tv)
	// gespeicherte Sortierung wiederherstellen (z. B. „Geändert“ absteigend = neueste zuerst)
	order := walk.SortAscending
	if *p.sortDesc {
		order = walk.SortDescending
	}
	if *p.sortCol < 0 || *p.sortCol >= len(colSortKey) {
		*p.sortCol = 0
	}
	p.model.Sort(*p.sortCol, order)
	p.model.onSort = func(col int, asc bool) {
		if col != *p.sortCol || asc == *p.sortDesc {
			*p.sortCol, *p.sortDesc = col, !asc
			p.app.cfg.Save()
		}
	}
	p.tv.KeyDown().Attach(func(key walk.Key) {
		switch {
		case key == walk.KeyC && walk.ControlDown() && walk.ShiftDown():
			p.copyText(true)
		case key == walk.KeyC && walk.ControlDown():
			p.copyFiles()
		case key == walk.KeyBack && p.model.folderMode:
			p.goUp()
		}
	})
	p.setupDrag()
	err := RegisterDropTarget(uintptr(p.tv.Handle()), p)
	dbg("RegisterDropTarget pane=%d: %v", p.idx, err)
	p.updateFilterButtons(nil)
	p.rebuildCopyMenu()
}

func (p *Pane) setStatus(s string) {
	if p.idx == 1 && !p.app.cfg.SecondPane {
		return // ausgeblendete rechte Hälfte meldet nichts
	}
	if time.Now().Before(p.app.stickyUntil) {
		return // eine wichtige Meldung (z. B. „verschoben“) bleibt kurz stehen
	}
	p.app.setStatus(s)
}

// ---------- Suche ----------

func (p *Pane) searchTextChanged() {
	if p.model.folderMode {
		p.leaveFolder()
	}
	p.scheduleSearch()
}

func (p *Pane) searchKey(key walk.Key) {
	switch key {
	case walk.KeyDown, walk.KeyReturn:
		if p.model.RowCount() > 0 {
			p.tv.SetFocus()
			p.tv.SetCurrentIndex(0)
		}
	}
}

func (p *Pane) scheduleSearch() {
	gen := p.searchGen.Add(1)
	if p.debounce != nil {
		p.debounce.Stop()
	}
	p.debounce = time.AfterFunc(120*time.Millisecond, func() {
		p.app.mw.Synchronize(func() { p.runSearch(gen) })
	})
}

func (p *Pane) runSearch(gen int64) {
	if gen != p.searchGen.Load() {
		return
	}
	if p.model.folderMode {
		p.refreshFolder()
		return
	}
	ix := p.app.ix
	q := Query{Text: p.search.Text(), Filter: *p.filter, InPath: p.inPath.Checked(), MaxResult: maxResults}
	if ix == nil || (strings.TrimSpace(q.Text) == "" && q.Filter == 0) {
		p.model.set(ix, nil)
		p.updateFilterButtons(nil)
		if !p.app.indexing {
			p.setStatus(p.app.lastInfo)
		}
		return
	}
	go func() {
		start := time.Now()
		res, total, counts := ix.Search(q, func() bool { return gen != p.searchGen.Load() })
		if gen != p.searchGen.Load() {
			return
		}
		el := time.Since(start)
		p.app.mw.Synchronize(func() {
			if gen != p.searchGen.Load() || p.model.folderMode {
				return
			}
			p.model.set(ix, res)
			p.updateFilterButtons(&counts)
			if !p.app.indexing {
				msg := fmt.Sprintf("%s Treffer (%d ms)", thousands(int64(total)), el.Milliseconds())
				if names := p.filterNames(); names != "" {
					msg = names + ": " + msg
				}
				if p.app.cfg.SecondPane {
					msg = [2]string{"Links", "Rechts"}[p.idx] + " – " + msg
				}
				if total > len(res) {
					msg += fmt.Sprintf(" – nur die ersten %s werden angezeigt, bitte Suche verfeinern", thousands(int64(len(res))))
				}
				p.setStatus(msg + "   |   " + p.app.lastInfo)
			}
		})
	}()
}

// ---------- Haken ----------

func (p *Pane) filterChanged() {
	var f uint8
	for c := CatPDF; c <= CatFolder; c++ {
		if b := p.filterBtns[c]; b != nil && b.Checked() {
			f |= FilterBit(c)
		}
	}
	if f == *p.filter {
		return
	}
	*p.filter = f
	p.app.cfg.Save()
	p.scheduleSearch()
}

func (p *Pane) filterNames() string {
	var n []string
	for c := CatPDF; c <= CatFolder; c++ {
		if *p.filter&FilterBit(c) != 0 {
			n = append(n, CatNames[c])
		}
	}
	return strings.Join(n, " + ")
}

func (p *Pane) updateFilterButtons(counts *[NumCats]int) {
	for c := CatPDF; c <= CatFolder; c++ {
		b := p.filterBtns[c]
		if b == nil {
			continue
		}
		text := CatNames[c]
		if counts != nil {
			text += " (" + thousands(int64(counts[c])) + ")"
		}
		b.SetText(text)
	}
}

// ---------- Ordneransicht ----------

// openFolder zeigt den Inhalt eines Ordners in dieser Hälfte (live vom NAS gelesen).
func (p *Pane) openFolder(dir string) {
	p.model.folder = dir
	p.model.folderMode = true
	p.buildCrumbs(dir)
	p.pathBar.SetVisible(true)
	p.refreshFolder()
}

func (p *Pane) refreshFolder() {
	dir := p.model.folder
	// Der Haken „Ordner“ dient zum Finden von Ordnern – in der Ordneransicht zählen nur Dateitypen.
	filter := *p.filter &^ FilterBit(CatFolder)
	excl := map[string]bool{}
	for _, e := range p.app.cfg.Excludes {
		excl[strings.ToLower(e)] = true
	}
	p.setStatus("Lese Ordner " + dir + " …")
	go func() {
		ents, err := os.ReadDir(dir)
		var items []Entry
		var counts [NumCats]int
		for _, de := range ents {
			name := de.Name()
			if excl[strings.ToLower(name)] || strings.HasPrefix(name, sharedIndexName) {
				continue
			}
			e := Entry{Name: name, IsDir: de.IsDir()}
			if info, err := de.Info(); err == nil {
				e.Mod = info.ModTime().Unix()
				if !e.IsDir {
					e.Size = info.Size()
				}
			}
			cat := int(categoryOf(normLower(name), e.IsDir))
			counts[cat]++
			counts[CatAll]++
			// Unterordner bleiben immer sichtbar, damit man weiter navigieren kann.
			if filter != 0 && !e.IsDir && filter&FilterBit(cat) == 0 {
				continue
			}
			items = append(items, e)
		}
		p.app.mw.Synchronize(func() {
			if !p.model.folderMode || p.model.folder != dir {
				return
			}
			p.model.setFolder(dir, items)
			p.updateFilterButtons(&counts)
			if err != nil {
				p.setStatus("Ordner nicht lesbar: " + err.Error())
			} else {
				p.setStatus(fmt.Sprintf("%s: %d Einträge – Dateien hierher ziehen = verschieben (mit Strg = kopieren)", dir, len(items)))
			}
		})
	}()
}

func (p *Pane) goUp() {
	if !p.model.folderMode {
		return
	}
	parent := filepath.Dir(p.model.folder)
	if parent == p.model.folder || parent == "." || strings.HasSuffix(parent, `\\`) {
		return
	}
	p.openFolder(parent)
}

func (p *Pane) leaveFolder() {
	p.model.folderMode = false
	p.pathBar.SetVisible(false)
}

func (p *Pane) backToSearch() {
	p.leaveFolder()
	p.scheduleSearch()
	p.search.SetFocus()
}

// ---------- Aktionen ----------

func (p *Pane) selectedPaths() []string {
	var out []string
	for _, i := range p.tv.SelectedIndexes() {
		if s := p.model.path(i); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		if s := p.model.path(p.tv.CurrentIndex()); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// activate: Ordner → in dieser Hälfte öffnen, Datei → mit dem passenden Programm öffnen.
func (p *Pane) activate() {
	paths := p.selectedPaths()
	if len(paths) == 1 {
		if e, _ := p.model.entry(p.tv.CurrentIndex()); e != nil && e.IsDir {
			p.openFolder(paths[0])
			return
		}
	}
	if len(paths) > 10 {
		if walk.MsgBox(p.app.mw, brandProduct, fmt.Sprintf("%d Dateien öffnen?", len(paths)),
			walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != walk.DlgCmdYes {
			return
		}
	}
	for _, s := range paths {
		if _, err := os.Stat(s); err != nil {
			walk.MsgBox(p.app.mw, brandProduct, "Nicht mehr vorhanden oder kein Zugriff:\n"+s+
				"\n\nTipp: Index aktualisieren (F5).", walk.MsgBoxIconWarning)
			continue
		}
		win.ShellExecute(p.app.mw.Handle(), syscall.StringToUTF16Ptr("open"),
			syscall.StringToUTF16Ptr(s), nil, nil, win.SW_SHOWNORMAL)
	}
}

// openInOther öffnet den gewählten Ordner (bzw. den Ordner der Datei) in der anderen Hälfte.
func (p *Pane) openInOther() {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	dir := paths[0]
	if e, _ := p.model.entry(p.tv.CurrentIndex()); e == nil || !e.IsDir {
		dir = filepath.Dir(dir)
	}
	p.app.setSecondPane(true)
	p.other().openFolder(dir)
}

func openExplorer(path string, sel bool) {
	if path == "" {
		return
	}
	cmd := exec.Command("explorer.exe")
	if sel {
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + path + `"`}
	} else {
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe "` + path + `"`}
	}
	cmd.Start()
}

func (p *Pane) showInFolder() {
	if paths := p.selectedPaths(); len(paths) > 0 {
		openExplorer(paths[0], true)
	}
}

func (p *Pane) copyText(full bool) {
	paths := p.selectedPaths()
	if !full {
		for i, s := range paths {
			paths[i] = filepath.Base(s)
		}
	}
	if len(paths) > 0 {
		walk.Clipboard().SetText(strings.Join(paths, "\r\n"))
		p.setStatus(fmt.Sprintf("%d %s in die Zwischenablage kopiert.", len(paths), map[bool]string{true: "Pfad(e)", false: "Name(n)"}[full]))
	}
}

func (p *Pane) copyFiles() {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	if err := CopyFilesToClipboard(uintptr(p.app.mw.Handle()), paths); err != nil {
		p.setStatus("Kopieren fehlgeschlagen: " + err.Error())
		return
	}
	p.setStatus(fmt.Sprintf("%d Datei(en) kopiert – mit Strg+V im Explorer, in E-Mails, Google Drive usw. einfügen.", len(paths)))
}

func (p *Pane) rebuildCopyMenu() {
	if p.copyMenu == nil {
		return
	}
	a := p.app
	acts := p.copyMenu.Actions()
	acts.Clear()
	add := func(text string, f func()) {
		act := walk.NewAction()
		act.SetText(text)
		act.Triggered().Attach(f)
		acts.Add(act)
	}
	targets := append([]string(nil), a.cfg.CopyTargets...)
	if a.gdrive != "" {
		known := false
		for _, t := range targets {
			known = known || strings.EqualFold(t, a.gdrive)
		}
		if !known {
			targets = append(targets, a.gdrive)
		}
	}
	for _, t := range targets {
		t := t
		label := strings.ReplaceAll(t, "&", "&&")
		if strings.EqualFold(t, a.gdrive) {
			label = "Google Drive  (" + label + ")"
		}
		add(label, func() { p.copyTo(t) })
	}
	if len(targets) > 0 {
		acts.Add(walk.NewSeparatorAction())
	}
	add("Ordner auswählen …", func() {
		fd := &walk.FileDialog{Title: "Wohin sollen die Dateien kopiert werden?"}
		if ok, _ := fd.ShowBrowseFolder(a.mw); ok && fd.FilePath != "" {
			p.copyTo(fd.FilePath)
		}
	})
}

func (p *Pane) copyTo(target string) {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	p.app.cfg.addCopyTarget(target)
	p.app.cfg.Save()
	p.app.rebuildCopyMenus()
	p.app.transfer(paths, target, false)
}

// ---------- Ziehen (Quelle) ----------

func (p *Pane) setupDrag() {
	p.tv.MouseDown().Attach(func(x, y int, b walk.MouseButton) {
		p.dragArmed = b == walk.LeftButton
		p.dragX, p.dragY = x, y
	})
	p.tv.MouseUp().Attach(func(x, y int, b walk.MouseButton) { p.dragArmed = false })
	p.tv.MouseMove().Attach(func(x, y int, b walk.MouseButton) {
		if !p.dragArmed || b&walk.LeftButton == 0 {
			return
		}
		dx, dy := x-p.dragX, y-p.dragY
		if dx*dx+dy*dy < 25 {
			return
		}
		p.dragArmed = false
		paths := p.selectedPaths()
		if len(paths) == 0 {
			return
		}
		dbg("Ziehen startet: %d Dateien", len(paths))
		if err := DragFiles(uintptr(p.app.mw.Handle()), paths); err != nil {
			p.setStatus("Ziehen nicht möglich: " + err.Error())
		}
	})
}

// ---------- Ablegen (Ziel) ----------

// dropFolder: Zielordner unter dem Mauszeiger – ein Ordner in der Liste oder,
// in der Ordneransicht, der angezeigte Ordner. "" = hier kann nichts abgelegt werden.
func (p *Pane) dropFolder(x, y int32) string {
	if row := p.rowAtScreen(x, y); row >= 0 {
		if e, _ := p.model.entry(row); e != nil && e.IsDir {
			return p.model.path(row)
		}
	}
	if p.model.folderMode {
		return p.model.folder
	}
	return ""
}

var procWindowFromPoint = user32.NewProc("WindowFromPoint")

func (p *Pane) rowAtScreen(x, y int32) int {
	h, _, _ := procWindowFromPoint.Call(uintptr(uint32(x)) | uintptr(uint32(y))<<32)
	if h == 0 {
		return -1
	}
	hwnd := win.HWND(h)
	if hwnd != p.tv.Handle() && !win.IsChild(p.tv.Handle(), hwnd) {
		return -1
	}
	var hti win.LVHITTESTINFO
	hti.Pt = win.POINT{X: x, Y: y}
	win.ScreenToClient(hwnd, &hti.Pt)
	idx := win.SendMessage(hwnd, win.LVM_HITTEST, 0, uintptr(unsafe.Pointer(&hti)))
	if int32(idx) < 0 || hti.Flags&win.LVHT_ONITEM == 0 {
		return -1
	}
	return int(int32(idx))
}

// DropEffect: Standard = verschieben, mit gedrückter Strg-Taste = kopieren.
func (p *Pane) DropEffect(paths []string, keys uint32, x, y int32) uint32 {
	p.autoScroll(x, y)
	p.springLoad(p.rowAtScreen(x, y))
	target := p.dropFolder(x, y)
	if target == "" {
		p.setDropHighlight(-1, false)
		p.showDropStatus("Hier ablegen geht nicht – erst einen Ordner öffnen (Doppelklick) oder direkt auf einen Ordner ziehen.")
		return dropEffectNone
	}
	for _, s := range paths {
		if strings.EqualFold(filepath.Dir(s), target) || strings.EqualFold(s, target) {
			p.setDropHighlight(-1, false)
			p.showDropStatus("Liegt bereits in " + target)
			return dropEffectNone
		}
	}
	// Ziel sichtbar machen: Ordnerzeile blau – oder die Pfadleiste des geöffneten Ordners
	row := p.rowAtScreen(x, y)
	if e, _ := p.model.entry(row); e != nil && e.IsDir {
		p.setDropHighlight(row, false)
	} else {
		p.setDropHighlight(-1, true)
	}
	if keys&mkControl != 0 {
		p.showDropStatus("Loslassen = KOPIEREN nach " + target)
		return dropEffectCopy
	}
	p.showDropStatus("Loslassen = VERSCHIEBEN nach " + target + "   (Strg gedrückt halten = kopieren)")
	return dropEffectMove
}

var (
	colorDropRow   = walk.RGB(0xCC, 0xE8, 0xFF) // Explorer-Blau
	colorDropText  = walk.RGB(0x00, 0x3E, 0x8A)
	dropBarBrush   *walk.SolidColorBrush
	normalBarBrush *walk.SolidColorBrush
)

// setDropHighlight hebt das aktuelle Ablageziel hervor (nur bei Änderung neu zeichnen).
func (p *Pane) setDropHighlight(row int, whole bool) {
	if row != p.dropRow {
		p.dropRow = row
		p.tv.Invalidate()
	}
	if whole != p.dropWhole {
		p.dropWhole = whole
		if dropBarBrush == nil {
			dropBarBrush, _ = walk.NewSolidColorBrush(colorDropRow)
			normalBarBrush, _ = walk.NewSolidColorBrush(walk.RGB(0xF0, 0xF0, 0xF0))
		}
		if whole {
			p.pathBar.SetBackground(dropBarBrush)
			p.pathLabel.SetText("   ▼ Hier ablegen")
		} else {
			p.pathBar.SetBackground(normalBarBrush)
			p.pathLabel.SetText("")
		}
	}
}

func (p *Pane) showDropStatus(s string) {
	if s != p.dropStatus {
		p.dropStatus = s
		p.setStatus(s)
	}
}

func (p *Pane) Drop(paths []string, effect uint32, x, y int32) {
	p.dropStatus = ""
	defer p.endDrag()
	target := p.dropFolder(x, y)
	if target == "" {
		return
	}
	list := append([]string(nil), paths...)
	// erst nach dem Ende des Zieh-Vorgangs ausführen
	p.app.mw.Synchronize(func() { p.app.transfer(list, target, effect == dropEffectMove) })
}

func (p *Pane) DragLeave() {
	p.dropStatus = ""
	p.endDrag()
	p.setStatus(p.app.lastInfo)
}

// ---------- Aufspringende Ordner beim Ziehen ----------

const springDelay = 600 * time.Millisecond

// springLoad: verweilt man mit Dateien über einem Ordner, klappen seine Unterordner
// darunter als Baum auf – so kann man direkt in „Kunde › Schaden“ ablegen.
func (p *Pane) springLoad(row int) {
	e, _ := p.model.entry(row)
	if e == nil || !e.IsDir || p.model.isOpen(row) || p.noSubs[p.model.path(row)] {
		p.hoverRow = -1
		return
	}
	if row != p.hoverRow {
		p.hoverRow, p.hoverAt = row, time.Now()
		return
	}
	if time.Since(p.hoverAt) < springDelay {
		return
	}
	p.hoverRow = -1
	path := p.model.path(row)
	subs := p.subfolders(path)
	if len(subs) == 0 {
		p.noSubs[path] = true
		return
	}
	if len(subs) > 300 {
		subs = subs[:300]
	}
	p.model.expandRow(row, subs)
}

var procGetClientRect = user32.NewProc("GetClientRect")

// autoScroll rollt die Liste beim Ziehen am oberen/unteren Rand weiter.
func (p *Pane) autoScroll(x, y int32) {
	h, _, _ := procWindowFromPoint.Call(uintptr(uint32(x)) | uintptr(uint32(y))<<32)
	hwnd := win.HWND(h)
	if h == 0 || (hwnd != p.tv.Handle() && !win.IsChild(p.tv.Handle(), hwnd)) {
		return
	}
	if time.Since(p.lastScroll) < 80*time.Millisecond {
		return
	}
	pt := win.POINT{X: x, Y: y}
	win.ScreenToClient(hwnd, &pt)
	var rc win.RECT
	procGetClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rc)))
	dpi := int32(p.tv.DPI())
	zone, step := 45*dpi/96, 18*dpi/96
	const lvmScroll = 0x1000 + 20
	switch {
	case pt.Y < rc.Top+zone:
		win.SendMessage(hwnd, lvmScroll, 0, uintptr(-step))
	case pt.Y > rc.Bottom-zone/2:
		win.SendMessage(hwnd, lvmScroll, 0, uintptr(step))
	default:
		return
	}
	p.lastScroll = time.Now()
}

// endDrag: Markierung entfernen und aufgeklappte Ordner wieder zuklappen.
func (p *Pane) endDrag() {
	p.setDropHighlight(-1, false)
	p.hoverRow = -1
	p.model.collapseAll()
}
