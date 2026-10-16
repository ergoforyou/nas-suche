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

// Pane ist eine Ansicht: oben die Suche (Trefferliste aus dem Index) oder unten links/rechts
// ein Explorer-Fenster mit Zurück/Vor/Nach oben, Pfadleiste und Ordnerinhalt.
type Pane struct {
	app    *App
	idx    int  // 0 = links, 1 = rechts, 2 = Suche oben
	search bool // true = Suchansicht oben
	root   *walk.Composite
	tv     *walk.TableView
	model  *ResultModel

	// Suche
	searchEd   *walk.LineEdit
	inPath     *walk.CheckBox
	scopeCB    *walk.ComboBox
	filterBtns [CatFolder + 1]*walk.CheckBox // Index = Kategorie, 0 unbenutzt
	searchGen  atomic.Int64
	debounce   *time.Timer

	// Explorer
	pathBar       *walk.Composite
	pathLabel     *walk.Label
	crumbs        *walk.Composite // Pfad als anklickbare Teilstücke mit Unterordner-Auswahl
	crumbSlots    []*crumbSlot
	crumbMore     *walk.PushButton
	crumbMorePath string
	addrEd        *walk.LineEdit // Pfad eintippen (Strg+L / F4 / Alt+D)
	backBt, fwdBt *walk.PushButton
	upBt          *walk.PushButton
	favBtn        *walk.PushButton
	info          *walk.Label // „23 Elemente · 2 ausgewählt“
	history       []string
	histPos       int

	sortCol  *int
	sortDesc *bool

	dropRow    int // beim Ziehen hervorgehobene Ordnerzeile (-1 = keine)
	hoverRow   int // Ordnerzeile, über der beim Ziehen verweilt wird
	hoverAt    time.Time
	noSubs     map[string]bool // Ordner ohne Unterordner (nicht erneut lesen)
	lastScroll time.Time
	dropWhole  bool // ganzer geöffneter Ordner ist Ziel

	dragArmed  bool
	dragX      int
	dragY      int
	dropStatus string
}

func newPane(a *App, idx int) *Pane {
	p := &Pane{app: a, idx: idx, search: idx == 2, model: &ResultModel{sortCol: 0, asc: true}}
	p.dropRow, p.hoverRow = -1, -1
	p.noSubs = map[string]bool{}
	switch idx {
	case 0:
		p.sortCol, p.sortDesc = &a.cfg.SortColL, &a.cfg.SortDescL
	case 1:
		p.sortCol, p.sortDesc = &a.cfg.SortColR, &a.cfg.SortDescR
	default:
		p.sortCol, p.sortDesc = &a.cfg.SortCol, &a.cfg.SortDesc
	}
	return p
}

func (p *Pane) side() string { return [3]string{"links", "rechts", "Suche"}[p.idx] }

// other: die andere Explorer-Ansicht (für die Suche: die zuletzt benutzte).
func (p *Pane) other() *Pane {
	if p.search {
		return p.app.explorerPane()
	}
	return p.app.panes[1-p.idx]
}

func (p *Pane) table() TableView {
	return TableView{
		AssignTo:         &p.tv,
		StretchFactor:    1000,
		AlternatingRowBG: true,
		MultiSelection:   true,
		Columns: []TableViewColumn{
			{Title: "Name", Width: map[bool]int{true: 300, false: 280}[p.search]},
			{Title: "Typ", Width: 95},
			{Title: "Ordner", Width: 330, Hidden: !p.search},
			{Title: "Größe", Width: 75, Alignment: AlignFar},
			{Title: "Geändert", Width: 110},
		},
		Model:           p.model,
		StyleCell:       p.styleCell,
		OnItemActivated: p.activate,
		OnCurrentIndexChanged: func() {
			if !p.search {
				p.updateInfo()
			}
		},
		OnSelectedIndexesChanged: func() {
			if !p.search {
				p.updateInfo()
			}
		},
	}
}

// widget: Suchleiste oben (ein Drittel des Fensters).
func (p *Pane) searchWidget() Widget {
	var filters []Widget
	for c := CatPDF; c <= CatFolder; c++ {
		filters = append(filters, CheckBox{
			AssignTo:         &p.filterBtns[c],
			Text:             CatNames[c],
			Checked:          p.app.cfg.Filter&FilterBit(c) != 0,
			MinSize:          Size{Width: 82},
			OnCheckedChanged: p.filterChanged,
		})
	}
	return Composite{
		AssignTo: &p.root,
		Layout:   VBox{Margins: Margins{Left: 9, Top: 6, Right: 9, Bottom: 2}, Spacing: 4},
		Children: []Widget{
			Composite{
				Layout:  HBox{MarginsZero: true, Spacing: 8},
				MaxSize: Size{Height: 32},
				Children: append([]Widget{
					Label{Text: "Suchen:", Font: Font{Family: "Segoe UI", PointSize: 10, Bold: true}},
					LineEdit{
						AssignTo:      &p.searchEd,
						CueBanner:     "Dateien und Ordner finden …  z. B.  angebot müller *.pdf   (Strg+F)",
						Font:          Font{Family: "Segoe UI", PointSize: 12},
						MinSize:       Size{Width: 300},
						OnTextChanged: p.scheduleSearch,
						OnKeyDown:     p.searchKey,
					},
					ComboBox{
						AssignTo:              &p.scopeCB,
						Model:                 []string{"Überall (alle Suchordner)", "Nur im linken Ordner", "Nur im rechten Ordner"},
						CurrentIndex:          p.app.cfg.SearchScope,
						MinSize:               Size{Width: 175},
						OnCurrentIndexChanged: p.scopeChanged,
					},
					CheckBox{
						AssignTo:  &p.inPath,
						Text:      "Auch im Ordnerpfad",
						Checked:   p.app.cfg.InPath,
						OnClicked: func() { p.app.cfg.InPath = p.inPath.Checked(); p.app.cfg.Save(); p.scheduleSearch() },
					},
					Label{Text: "  Nur:"},
				}, filters...),
			},
			p.table(),
		},
	}
}

// explorerWidget: eine Explorer-Ansicht (links oder rechts).
func (p *Pane) explorerWidget() Widget {
	small := Size{Width: 30}
	return Composite{
		AssignTo:      &p.root,
		StretchFactor: 1,
		Layout:        VBox{MarginsZero: true, Spacing: 3},
		Children: []Widget{
			Composite{
				AssignTo: &p.pathBar,
				Layout:   HBox{MarginsZero: true, Spacing: 2},
				MaxSize:  Size{Height: 30},
				Children: []Widget{
					PushButton{AssignTo: &p.backBt, Text: "←", MinSize: small, MaxSize: small, ToolTipText: "Zurück (Alt+← / Rücktaste)", OnClicked: p.goBack},
					PushButton{AssignTo: &p.fwdBt, Text: "→", MinSize: small, MaxSize: small, ToolTipText: "Vor (Alt+→)", OnClicked: p.goForward},
					PushButton{AssignTo: &p.upBt, Text: "↑", MinSize: small, MaxSize: small, ToolTipText: "Eine Ebene höher (Alt+↑)", OnClicked: p.goUp},
					Composite{AssignTo: &p.crumbs, Layout: HBox{MarginsZero: true, Spacing: 0}},
					LineEdit{AssignTo: &p.addrEd, Visible: false, OnKeyDown: p.addrKey},
					Label{AssignTo: &p.pathLabel, Font: Font{Family: "Segoe UI", PointSize: 10, Bold: true}, TextColor: walk.RGB(0x00, 0x3E, 0x8A)},
					HSpacer{},
					PushButton{Text: "✎", MinSize: small, MaxSize: small, ToolTipText: "Pfad eintippen (Strg+L)", OnClicked: p.editAddress},
					PushButton{AssignTo: &p.favBtn, Text: "★", MinSize: small, MaxSize: small, ToolTipText: "Feste Ordner", OnClicked: p.showFolderMenu},
					PushButton{Text: "⟳", MinSize: small, MaxSize: small, ToolTipText: "Aktualisieren (F5)", OnClicked: p.refreshFolder},
				},
			},
			p.table(),
			Label{AssignTo: &p.info, TextColor: walk.RGB(0x55, 0x5F, 0x6B)},
		},
	}
}

// init wird nach dem Erzeugen des Fensters aufgerufen.
func (p *Pane) init() {
	p.model.onReset = func() { p.tv.Invalidate() }
	onlyNameIcons(p.tv)
	if !p.search {
		p.model.folderMode = true
	}
	// gespeicherte Sortierung wiederherstellen (z. B. „Geändert“ absteigend = neueste zuerst)
	order := walk.SortAscending
	if *p.sortDesc {
		order = walk.SortDescending
	}
	if *p.sortCol < 0 || *p.sortCol >= len(colSortKey) || (!p.search && *p.sortCol == 2) {
		*p.sortCol = 0
	}
	p.model.Sort(*p.sortCol, order)
	p.model.onSort = func(col int, asc bool) {
		if col != *p.sortCol || asc == *p.sortDesc {
			*p.sortCol, *p.sortDesc = col, !asc
			p.app.cfg.Save()
		}
	}
	p.tv.KeyDown().Attach(p.tableKey)
	p.setupDrag()
	mark := func() {
		p.app.lastPane = p
		if !p.search {
			p.app.lastExplorer = p
		}
		p.app.updateCommands()
	}
	p.tv.FocusedChanged().Attach(func() {
		if p.tv.Focused() {
			mark()
		}
	})
	if p.search {
		p.searchEd.FocusedChanged().Attach(func() {
			if p.searchEd.Focused() {
				mark()
			}
		})
	} else {
		p.addrEd.FocusedChanged().Attach(func() {
			if !p.addrEd.Focused() {
				p.app.mw.Synchronize(p.closeAddress)
			}
		})
	}
	p.tv.MouseDown().Attach(func(x, y int, b walk.MouseButton) {
		if b == walk.RightButton {
			mark()
			// nach dem Klick (die Liste markiert die Zeile selbst) das Menü zeigen
			p.app.mw.Synchronize(func() { p.contextMenu(false) })
		}
	})
	err := RegisterDropTarget(uintptr(p.tv.Handle()), p)
	dbg("RegisterDropTarget pane=%d: %v", p.idx, err)
	if !p.search {
		RegisterDropTarget(uintptr(p.pathBar.Handle()), &barDrop{p})
	}
	p.updateFilterButtons(nil)
	p.updateNavButtons()
}

func (p *Pane) setStatus(s string) {
	if time.Now().Before(p.app.stickyUntil) {
		return // eine wichtige Meldung (z. B. „verschoben“) bleibt kurz stehen
	}
	p.app.setStatus(s)
}

// tableKey: Tasten in der Liste – wie im Windows-Explorer.
func (p *Pane) tableKey(key walk.Key) {
	ctrl, shift := walk.ControlDown(), walk.ShiftDown()
	switch {
	case key == walk.KeyC && ctrl && shift:
		p.copyText(true)
	case key == walk.KeyC && ctrl:
		p.app.clipboardSet(p, false)
	case key == walk.KeyX && ctrl:
		p.app.clipboardSet(p, true)
	case key == walk.KeyV && ctrl:
		p.app.paste(p)
	case key == walk.KeyA && ctrl:
		p.selectAll()
	case key == walk.KeyN && ctrl && shift:
		p.newFolder()
	case key == walk.KeyDelete:
		p.deleteSelected(!shift)
	case key == walk.KeyF2:
		p.rename()
	case key == walk.KeyF5:
		p.refreshFolder()
	case key == walk.KeyBack && !p.search:
		p.goBack()
	case key == walk.KeyApps || (key == walk.KeyF10 && shift):
		p.contextMenu(true)
	case (key == walk.KeyL && ctrl) || key == walk.KeyF4:
		if !p.search {
			p.editAddress()
		}
	}
}

// ---------- Suche ----------

func (p *Pane) searchKey(key walk.Key) {
	switch key {
	case walk.KeyDown, walk.KeyReturn:
		if p.model.RowCount() > 0 {
			p.tv.SetFocus()
			p.tv.SetCurrentIndex(0)
		}
	case walk.KeyEscape:
		if p.searchEd.Text() != "" {
			p.searchEd.SetText("")
		}
	}
}

func (p *Pane) scopeChanged() {
	if i := p.scopeCB.CurrentIndex(); i >= 0 && i != p.app.cfg.SearchScope {
		p.app.cfg.SearchScope = i
		p.app.cfg.Save()
		p.scheduleSearch()
	}
}

func (p *Pane) scheduleSearch() {
	if !p.search {
		return
	}
	gen := p.searchGen.Add(1)
	if p.debounce != nil {
		p.debounce.Stop()
	}
	p.debounce = time.AfterFunc(120*time.Millisecond, func() {
		p.app.mw.Synchronize(func() { p.runSearch(gen) })
	})
}

// scopeFolder: der Ordner, auf den die Suche beschränkt ist ("" = überall).
func (p *Pane) scopeFolder() string {
	switch p.app.cfg.SearchScope {
	case 1:
		return p.app.panes[0].model.folder
	case 2:
		return p.app.panes[1].model.folder
	}
	return ""
}

func (p *Pane) runSearch(gen int64) {
	if gen != p.searchGen.Load() {
		return
	}
	ix := p.app.ix
	q := Query{Text: p.searchEd.Text(), Filter: p.app.cfg.Filter, InPath: p.inPath.Checked(), MaxResult: maxResults}
	scope := p.scopeFolder()
	if strings.TrimSpace(q.Text) == "" && q.Filter == 0 {
		p.model.set(ix, nil)
		p.updateFilterButtons(nil)
		if !p.app.indexing {
			p.setStatus(p.app.lastInfo)
		}
		return
	}
	// Ordner außerhalb der Suchordner: direkt auf dem Laufwerk durchsuchen
	live := scope != "" && (ix == nil || !ix.Covers(scope))
	if ix == nil && !live {
		p.model.set(nil, nil)
		p.setStatus("Noch kein Index – bitte unter „Einstellungen“ die Suchordner festlegen oder „Nur im linken Ordner“ wählen.")
		return
	}
	excl := append([]string(nil), p.app.cfg.Excludes...)
	if live {
		p.setStatus("Durchsuche " + scope + " …")
	}
	go func() {
		start := time.Now()
		cancel := func() bool { return gen != p.searchGen.Load() }
		var res []int
		var total int
		var counts [NumCats]int
		six := ix
		if live {
			six, res, total, counts = LiveSearch(scope, q, excl, cancel)
		} else {
			q.Under = scope
			res, total, counts = ix.Search(q, cancel)
		}
		if cancel() {
			return
		}
		el := time.Since(start)
		p.app.mw.Synchronize(func() {
			if cancel() {
				return
			}
			p.model.set(six, res)
			p.updateFilterButtons(&counts)
			if !p.app.indexing || live {
				msg := fmt.Sprintf("%s Treffer (%d ms)", thousands(int64(total)), el.Milliseconds())
				if names := p.filterNames(); names != "" {
					msg = names + ": " + msg
				}
				if scope != "" {
					msg += " in " + scope
					if live {
						msg += " (direkt durchsucht)"
					}
				}
				if total > len(res) {
					msg += fmt.Sprintf(" – nur die ersten %s werden angezeigt, bitte Suche verfeinern", thousands(int64(len(res))))
				}
				if !live {
					msg += "   |   " + p.app.lastInfo
				}
				p.setStatus(msg)
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
	if f == p.app.cfg.Filter {
		return
	}
	p.app.cfg.Filter = f
	p.app.cfg.Save()
	p.scheduleSearch()
}

func (p *Pane) filterNames() string {
	var n []string
	for c := CatPDF; c <= CatFolder; c++ {
		if p.app.cfg.Filter&FilterBit(c) != 0 {
			n = append(n, CatNames[c])
		}
	}
	return strings.Join(n, " + ")
}

func (p *Pane) updateFilterButtons(counts *[NumCats]int) {
	if !p.search {
		return
	}
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

// ---------- Ordneransicht (Explorer) ----------

// openFolder zeigt einen Ordner in dieser Ansicht (live vom Laufwerk gelesen) und merkt ihn im Verlauf.
func (p *Pane) openFolder(dir string) {
	if p.search {
		t := p.other()
		t.openFolder(dir)
		t.tv.SetFocus()
		return
	}
	p.openFolderSel(dir, "")
}

// openFolderSel öffnet einen Ordner und markiert darin ein Element (z. B. nach „Nach oben“).
func (p *Pane) openFolderSel(dir, sel string) {
	dir = cleanDir(dir)
	if dir == "" {
		return
	}
	if p.histPos < len(p.history) && strings.EqualFold(p.history[p.histPos], dir) {
		// gleicher Ordner: nur neu lesen
	} else {
		if len(p.history) > 0 {
			p.history = p.history[:p.histPos+1]
		}
		p.history = append(p.history, dir)
		if len(p.history) > 50 {
			p.history = p.history[len(p.history)-50:]
		}
		p.histPos = len(p.history) - 1
	}
	p.showFolder(dir, sel)
}

func (p *Pane) showFolder(dir, sel string) {
	p.closeAddress()
	p.model.folder = dir
	p.model.folderMode = true
	p.buildCrumbs(dir)
	p.updateNavButtons()
	p.loadFolder(false, sel)
	p.rememberFolder(dir)
	if p.app.cfg.SearchScope == p.idx+1 {
		p.app.searchPane.scheduleSearch()
	}
}

// rememberFolder: beim nächsten Start wieder hier anfangen (sofern kein fester Startordner gilt).
func (p *Pane) rememberFolder(dir string) {
	last := &p.app.cfg.LastFolder
	if p.idx == 1 {
		last = &p.app.cfg.LastFolder2
	}
	if *last != dir {
		*last = dir
		p.app.saveSoon()
	}
}

func cleanDir(dir string) string {
	dir = strings.TrimSpace(strings.Trim(strings.TrimSpace(dir), `"`))
	if dir == "" {
		return ""
	}
	if len(dir) == 2 && dir[1] == ':' {
		dir += `\`
	}
	return filepath.Clean(dir)
}

func (p *Pane) updateNavButtons() {
	if p.search || p.backBt == nil {
		return
	}
	p.backBt.SetEnabled(p.histPos > 0)
	p.fwdBt.SetEnabled(p.histPos < len(p.history)-1)
	p.upBt.SetEnabled(p.parentDir() != "")
}

func (p *Pane) goBack() {
	if p.search || p.histPos <= 0 {
		return
	}
	cur := p.model.folder
	p.histPos--
	p.showFolder(p.history[p.histPos], cur)
}

func (p *Pane) goForward() {
	if p.search || p.histPos >= len(p.history)-1 {
		return
	}
	p.histPos++
	p.showFolder(p.history[p.histPos], "")
}

func (p *Pane) parentDir() string {
	dir := p.model.folder
	if dir == "" {
		return ""
	}
	parent := filepath.Dir(dir)
	if parent == dir || parent == "." || strings.HasSuffix(parent, `\\`) || ShareRoot(dir) == strings.TrimRight(dir, `\`) {
		return ""
	}
	return parent
}

func (p *Pane) goUp() {
	if parent := p.parentDir(); parent != "" {
		p.openFolderSel(parent, p.model.folder)
	}
}

func (p *Pane) refreshFolder() {
	if p.search {
		p.scheduleSearch()
		return
	}
	p.loadFolder(false, "")
}

// loadFolder liest den geöffneten Ordner. silent = automatische Aktualisierung im Hintergrund:
// keine Statusmeldung, nur bei Änderungen neu anzeigen, Auswahl bleibt erhalten.
func (p *Pane) loadFolder(silent bool, selectPath string) {
	dir := p.model.folder
	if dir == "" {
		return
	}
	excl := map[string]bool{}
	for _, e := range p.app.cfg.Excludes {
		excl[strings.ToLower(e)] = true
	}
	showHidden := p.app.cfg.ShowHidden
	if !silent {
		p.info.SetText("Lese " + dir + " …")
	}
	go func() {
		ents, err := os.ReadDir(dir)
		if silent && err != nil {
			return
		}
		var items []Entry
		for _, de := range ents {
			name := de.Name()
			if !showHidden && (excl[strings.ToLower(name)] || strings.HasPrefix(name, sharedIndexName) || hiddenEntry(de)) {
				continue
			}
			e := Entry{Name: name, IsDir: de.IsDir()}
			if info, err := de.Info(); err == nil {
				e.Mod = info.ModTime().Unix()
				if !e.IsDir {
					e.Size = info.Size()
				}
			}
			items = append(items, e)
		}
		p.app.mw.Synchronize(func() {
			if p.model.folder != dir {
				return
			}
			if silent {
				if p.dragging() || sameItems(p.model.items, items) {
					return
				}
				sel := p.selectedPaths()
				p.model.setFolder(dir, items)
				p.reselect(sel)
				p.updateInfo()
				return
			}
			sel := p.selectedPaths()
			p.model.setFolder(dir, items)
			if selectPath != "" {
				sel = []string{selectPath}
			}
			p.reselect(sel)
			if err != nil {
				p.info.SetText("Ordner nicht lesbar: " + err.Error())
				p.setStatus(dir + ": nicht lesbar – " + err.Error())
			} else {
				p.updateInfo()
			}
		})
	}()
}

// updateInfo: Zeile unter der Liste – Anzahl, Auswahl und Größe der Auswahl.
func (p *Pane) updateInfo() {
	if p.search || p.info == nil {
		return
	}
	n := len(p.model.items)
	text := fmt.Sprintf("%s Elemente", thousands(int64(n)))
	if n == 1 {
		text = "1 Element"
	}
	if sel := p.tv.SelectedIndexes(); len(sel) > 0 {
		var size int64
		files := 0
		for _, i := range sel {
			if e, _ := p.model.entry(i); e != nil && !e.IsDir {
				size += e.Size
				files++
			}
		}
		text += fmt.Sprintf("   ·   %d ausgewählt", len(sel))
		if files > 0 {
			text += "  (" + formatSize(size) + ")"
		}
	}
	p.info.SetText(text)
}

// ---------- Adresszeile ----------

func (p *Pane) editAddress() {
	if p.search {
		return
	}
	p.crumbs.SetVisible(false)
	p.addrEd.SetVisible(true)
	p.addrEd.SetText(p.model.folder)
	p.addrEd.SetFocus()
	p.addrEd.SetTextSelection(0, -1)
}

func (p *Pane) closeAddress() {
	if p.search || p.addrEd == nil || !p.addrEd.Visible() {
		return
	}
	p.addrEd.SetVisible(false)
	p.crumbs.SetVisible(true)
}

func (p *Pane) addrKey(key walk.Key) {
	switch key {
	case walk.KeyReturn:
		dir := cleanDir(p.addrEd.Text())
		if dir == "" {
			p.closeAddress()
			return
		}
		st, err := os.Stat(dir)
		switch {
		case err != nil:
			walk.MsgBox(p.app.mw, brandProduct, "„"+dir+"“ wurde nicht gefunden.\nBitte die Schreibweise prüfen.", walk.MsgBoxIconWarning)
			p.addrEd.SetFocus()
		case !st.IsDir():
			hostOpen(dir) // Datei: öffnen wie im Explorer
			p.openFolderSel(filepath.Dir(dir), dir)
			p.tv.SetFocus()
		default:
			p.openFolderSel(dir, "")
			p.tv.SetFocus()
		}
	case walk.KeyEscape:
		p.closeAddress()
		p.tv.SetFocus()
	}
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
		if s := p.model.path(p.tv.CurrentIndex()); s != "" && p.tv.Focused() {
			out = append(out, s)
		}
	}
	return out
}

func (p *Pane) selectedEntries() []*Entry {
	var out []*Entry
	for _, i := range p.tv.SelectedIndexes() {
		if e, _ := p.model.entry(i); e != nil {
			out = append(out, e)
		}
	}
	return out
}

func (p *Pane) selectAll() {
	n := p.model.RowCount()
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	p.tv.SetSelectedIndexes(idx)
}

// activate: Ordner → öffnen (Suche: in der unteren Ansicht), Datei → mit dem passenden Programm öffnen.
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
		if isDir(s) {
			continue
		}
		if _, err := os.Stat(s); err != nil {
			walk.MsgBox(p.app.mw, brandProduct, "Nicht mehr vorhanden oder kein Zugriff:\n"+s+
				"\n\nTipp: Index aktualisieren.", walk.MsgBoxIconWarning)
			continue
		}
		win.ShellExecute(p.app.mw.Handle(), syscall.StringToUTF16Ptr("open"),
			syscall.StringToUTF16Ptr(s), nil, nil, win.SW_SHOWNORMAL)
	}
}

// showInPane öffnet den Ordner eines Treffers in einer Explorer-Ansicht und markiert ihn dort.
func (p *Pane) showInPane(target *Pane) {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	target.openFolderSel(filepath.Dir(paths[0]), paths[0])
	target.tv.SetFocus()
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

// targetFolder: wohin „Einfügen“, „Neuer Ordner“ usw. in dieser Ansicht gehen.
func (p *Pane) targetFolder() string {
	if p.search {
		return ""
	}
	return p.model.folder
}

// newFolder legt „Neuer Ordner“ an und lässt ihn gleich umbenennen (wie im Explorer).
func (p *Pane) newFolder() {
	p.newItem(true)
}

func (p *Pane) newItem(folder bool) {
	dir := p.targetFolder()
	if dir == "" {
		p = p.app.explorerPane()
		dir = p.model.folder
	}
	base := "Neuer Ordner"
	if !folder {
		base = "Neues Textdokument.txt"
	}
	dst := uniquePath(filepath.Join(dir, base))
	var err error
	if folder {
		err = os.Mkdir(dst, 0o755)
	} else {
		var f *os.File
		if f, err = os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644); err == nil {
			f.Close()
		}
	}
	if err != nil {
		walk.MsgBox(p.app.mw, brandProduct, "Anlegen nicht möglich:\n"+err.Error(), walk.MsgBoxIconWarning)
		return
	}
	p.app.added([]string{dst})
	p.model.items = append(p.model.items, Entry{Name: filepath.Base(dst), IsDir: folder, Mod: time.Now().Unix()})
	p.model.setFolder(dir, p.model.items)
	p.reselect([]string{dst})
	p.tv.SetFocus()
	p.rename()
}

// deleteSelected: Entf = Papierkorb, Umschalt+Entf = endgültig (Windows fragt nach).
func (p *Pane) deleteSelected(recycle bool) {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	p.app.deletePaths(paths, recycle)
}

func (p *Pane) properties() {
	paths := p.selectedPaths()
	if len(paths) == 0 && !p.search {
		paths = []string{p.model.folder}
	}
	ShowProperties(uintptr(p.app.mw.Handle()), paths)
}

// ---------- Kontextmenü ----------

func (p *Pane) contextMenu(keyboard bool) {
	a := p.app
	paths := p.selectedPaths()
	var pt win.POINT
	win.GetCursorPos(&pt)
	if keyboard {
		var rc win.RECT
		win.GetWindowRect(p.tv.Handle(), &rc)
		pt = win.POINT{X: rc.Left + 40, Y: rc.Top + 40}
	}
	// Leere Fläche: Menü des Ordners
	if len(paths) == 0 {
		if p.search {
			return
		}
		dir := p.model.folder
		popupMenu(a.mw.Handle(), pt.X, pt.Y, []popItem{
			{text: "Einfügen\tStrg+V", disabled: !ClipboardHasFiles(), action: func() { a.paste(p) }},
			{separator: true},
			{text: "Neuer Ordner\tStrg+Umschalt+N", action: p.newFolder},
			{text: "Neues Textdokument", action: func() { p.newItem(false) }},
			{separator: true},
			{text: "Alles auswählen\tStrg+A", action: p.selectAll},
			{text: "Aktualisieren\tF5", action: p.refreshFolder},
			{text: "Versteckte Dateien anzeigen", checked: a.cfg.ShowHidden, action: a.toggleHidden},
			{separator: true},
			{text: "Im Windows-Explorer öffnen", action: func() { openExplorer(dir, false) }},
			{text: "Pfad kopieren", action: func() { walk.Clipboard().SetText(dir) }},
			{text: "An Schnellzugriff anheften", disabled: a.nav.isPinned(dir) >= 0, action: func() { a.nav.pin(dir) }},
			{text: "Eigenschaften\tAlt+Enter", action: func() { ShowProperties(uintptr(a.mw.Handle()), []string{dir}) }},
		})
		return
	}
	ents := p.selectedEntries()
	one := len(paths) == 1
	firstDir := one && len(ents) == 1 && ents[0].IsDir
	sameParent := true
	for _, s := range paths {
		sameParent = sameParent && strings.EqualFold(filepath.Dir(s), filepath.Dir(paths[0]))
	}
	items := []popItem{{text: "Öffnen\tEnter", action: p.activate}}
	if one && !firstDir {
		items = append(items, popItem{text: "Öffnen mit …", action: func() { OpenWith(paths[0]) }})
	}
	if p.search {
		items = append(items,
			popItem{text: "Ordner links anzeigen (Datei markiert)", action: func() { p.showInPane(a.panes[0]) }},
			popItem{text: "Ordner rechts anzeigen (Datei markiert)", action: func() { p.showInPane(a.panes[1]) }})
	} else if firstDir {
		items = append(items, popItem{text: "In der anderen Ansicht öffnen", action: func() { p.other().openFolderSel(paths[0], ""); p.other().tv.SetFocus() }})
	}
	items = append(items, popItem{text: "Im Windows-Explorer zeigen", action: func() { openExplorer(paths[0], true) }})
	if firstDir {
		if a.nav.isPinned(paths[0]) >= 0 {
			items = append(items, popItem{text: "Vom Schnellzugriff lösen", action: func() { a.nav.unpin(paths[0]) }})
		} else {
			items = append(items, popItem{text: "An Schnellzugriff anheften", action: func() { a.nav.pin(paths[0]) }})
		}
	}
	items = append(items,
		popItem{separator: true},
		popItem{text: "Ausschneiden\tStrg+X", action: func() { a.clipboardSet(p, true) }},
		popItem{text: "Kopieren\tStrg+C", action: func() { a.clipboardSet(p, false) }},
	)
	if firstDir {
		items = append(items, popItem{text: "Einfügen in diesen Ordner", disabled: !ClipboardHasFiles(), action: func() { a.pasteInto(paths[0]) }})
	}
	items = append(items,
		popItem{text: "Verschieben nach", sub: a.targetMenu(p, paths, true)},
		popItem{text: "Kopieren nach", sub: a.targetMenu(p, paths, false)},
		popItem{separator: true},
		popItem{text: map[bool]string{true: "Umbenennen\tF2", false: fmt.Sprintf("%d Elemente umbenennen …\tF2", len(paths))}[one], action: p.rename},
		popItem{text: "Löschen (Papierkorb)\tEntf", action: func() { p.deleteSelected(true) }},
		popItem{separator: true},
		popItem{text: "Pfad kopieren\tStrg+Umschalt+C", action: func() { p.copyText(true) }},
		popItem{text: "Name kopieren", action: func() { p.copyText(false) }},
		popItem{separator: true},
		popItem{text: "Weitere Optionen (Windows-Menü) …", disabled: !sameParent, action: func() { p.shellMenu(paths, pt) }},
		popItem{text: "Eigenschaften\tAlt+Enter", action: p.properties},
	)
	popupMenu(a.mw.Handle(), pt.X, pt.Y, items)
}

// shellMenu: das vollständige Kontextmenü des Windows-Explorers (7-Zip, Senden an, Freigeben …).
func (p *Pane) shellMenu(paths []string, pt win.POINT) {
	ran, err := ShellContextMenu(uintptr(p.app.mw.Handle()), paths, pt.X, pt.Y, walk.ShiftDown())
	if err != nil {
		p.setStatus("Windows-Menü: " + err.Error())
	}
	if ran {
		p.app.afterShellChange(paths)
	}
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
		p.app.dragSource = true
		_, err := DragFilesMove(uintptr(p.app.mw.Handle()), paths, true)
		p.app.dragSource = false
		if err != nil {
			p.setStatus("Ziehen nicht möglich: " + err.Error())
		}
		// Ziel war z. B. der Windows-Explorer: dort verschobene Dateien hier nachziehen
		p.app.afterShellChange(paths)
	})
}

// ---------- Ablegen (Ziel) ----------

// dropFolder: Zielordner unter dem Mauszeiger – ein Ordner in der Liste oder,
// in der Explorer-Ansicht, der angezeigte Ordner. "" = hier kann nichts abgelegt werden.
func (p *Pane) dropFolder(x, y int32) string {
	if row := p.rowAtScreen(x, y); row >= 0 {
		if e, _ := p.model.entry(row); e != nil && e.IsDir {
			return p.model.path(row)
		}
	}
	if !p.search {
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
	return p.effectFor(paths, keys, target, p.rowAtScreen(x, y))
}

func (p *Pane) effectFor(paths []string, keys uint32, target string, row int) uint32 {
	if target == "" {
		p.setDropHighlight(-1, false)
		p.showDropStatus("Hier ablegen geht nicht – direkt auf einen Ordner der Trefferliste oder in die untere Ansicht ziehen.")
		return dropEffectNone
	}
	for _, s := range paths {
		if strings.EqualFold(filepath.Dir(s), target) || strings.EqualFold(s, target) ||
			strings.HasPrefix(strings.ToLower(target), strings.ToLower(s)+`\`) {
			p.setDropHighlight(-1, false)
			p.showDropStatus("Liegt bereits in " + target)
			return dropEffectNone
		}
	}
	// Ziel sichtbar machen: Ordnerzeile blau – oder die Pfadleiste des geöffneten Ordners
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
	if p.search {
		whole = false
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
		p.app.setStatus(s)
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
	p.app.setStatus(p.app.lastInfo)
}

// barDrop: Ablegen auf der Pfadleiste = in den angezeigten Ordner.
type barDrop struct{ p *Pane }

func (b *barDrop) DropEffect(paths []string, keys uint32, x, y int32) uint32 {
	return b.p.effectFor(paths, keys, b.p.model.folder, -1)
}

func (b *barDrop) Drop(paths []string, effect uint32, x, y int32) {
	b.p.dropStatus = ""
	defer b.p.endDrag()
	list, target := append([]string(nil), paths...), b.p.model.folder
	b.p.app.mw.Synchronize(func() { b.p.app.transfer(list, target, effect == dropEffectMove) })
}

func (b *barDrop) DragLeave() { b.p.DragLeave() }

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
