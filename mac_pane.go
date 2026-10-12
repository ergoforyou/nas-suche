//go:build !windows

package main

import (
	"fmt"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// Eine Suchhälfte der Mac-Version.

type mrow struct {
	e     *Entry
	dir   string
	depth int  // > 0 = beim Ziehen aufgeklappter Unterordner
	open  bool // Unterordner aufgeklappt
}

var macColTitles = []string{"Name", "Typ", "Ordner", "Größe", "Geändert"}
var macColKey = []int{0, 4, 1, 2, 3} // Tabellenspalte → Sortierschlüssel

type MPane struct {
	app       *MacApp
	idx       int
	root      fyne.CanvasObject
	search    *widget.Entry
	inPath    *widget.Check
	filters   [CatFolder + 1]*widget.Check
	pathBar   *fyne.Container
	pathBg    *canvas.Rectangle
	pathLabel *widget.Label
	table     *widget.Table

	ix         *Index
	res        []int
	folderMode bool
	folder     string
	items      []Entry
	view       []mrow
	selRow     int
	dropRow    int
	hoverRow   int
	hoverAt    time.Time
	gen        atomic.Int64
	debounce   *time.Timer
}

func (p *MPane) filter() *uint8 {
	if p.idx == 0 {
		return &p.app.cfg.Filter
	}
	return &p.app.cfg.Filter2
}

func (p *MPane) sortCol() (*int, *bool) {
	if p.idx == 0 {
		return &p.app.cfg.SortCol, &p.app.cfg.SortDesc
	}
	return &p.app.cfg.SortCol2, &p.app.cfg.SortDesc2
}

func newMPane(a *MacApp, idx int) *MPane {
	p := &MPane{app: a, idx: idx, selRow: -1, dropRow: -1, hoverRow: -1}

	p.search = widget.NewEntry()
	p.search.SetPlaceHolder(map[int]string{0: "Suchen …  z. B. angebot müller *.pdf", 1: "Zweite Suche … z. B. Zielordner suchen und doppelklicken"}[idx])
	p.search.OnChanged = func(string) {
		if p.folderMode {
			p.leaveFolder()
		}
		p.scheduleSearch()
	}
	inPathCfg := &a.cfg.InPath
	if idx == 1 {
		inPathCfg = &a.cfg.InPath2
	}
	p.inPath = widget.NewCheck("Auch im Ordnerpfad", func(b bool) { *inPathCfg = b; a.cfg.Save(); p.scheduleSearch() })
	p.inPath.Checked = *inPathCfg

	row := []fyne.CanvasObject{widget.NewLabel("Nur anzeigen:")}
	for c := CatPDF; c <= CatFolder; c++ {
		c := c
		chk := widget.NewCheck(CatNames[c], func(on bool) {
			f := p.filter()
			if on {
				*f |= FilterBit(c)
			} else {
				*f &^= FilterBit(c)
			}
			a.cfg.Save()
			p.scheduleSearch()
		})
		chk.Checked = *p.filter()&FilterBit(c) != 0
		p.filters[c] = chk
		row = append(row, chk)
	}

	p.pathLabel = widget.NewLabel("")
	p.pathLabel.TextStyle = fyne.TextStyle{Bold: true}
	p.pathLabel.Truncation = fyne.TextTruncateEllipsis
	p.pathBg = canvas.NewRectangle(color.Transparent)
	p.pathBar = container.NewStack(p.pathBg, container.NewBorder(nil, nil,
		widget.NewButtonWithIcon("Nach oben", theme.MoveUpIcon(), p.goUp),
		container.NewHBox(
			widget.NewButton("Im Finder", func() { openPath(p.folder) }),
			widget.NewButtonWithIcon("Zurück zur Suche", theme.CancelIcon(), p.backToSearch)),
		p.pathLabel))
	p.pathBar.Hide()

	p.table = widget.NewTable(
		func() (int, int) { return len(p.view), len(macColTitles) },
		func() fyne.CanvasObject { return newCell(p) },
		func(id widget.TableCellID, o fyne.CanvasObject) { o.(*cell).update(id.Row, id.Col) })
	p.table.ShowHeaderRow = true
	p.table.CreateHeader = func() fyne.CanvasObject { return widget.NewButton("", nil) }
	p.table.UpdateHeader = func(id widget.TableCellID, o fyne.CanvasObject) {
		b := o.(*widget.Button)
		if id.Col < 0 {
			return
		}
		col, desc := p.sortCol()
		t := macColTitles[id.Col]
		if *col == id.Col {
			t += map[bool]string{true: "  ▼", false: "  ▲"}[*desc]
		}
		b.SetText(t)
		c := id.Col
		b.OnTapped = func() { p.sortBy(c) }
	}
	for i, w := range []float32{280, 95, 300, 80, 130} {
		p.table.SetColumnWidth(i, w)
	}

	folderBtn := widget.NewButton("Ordner ▼", nil)
	folderBtn.OnTapped = func() { p.folderMenu(folderBtn) }
	top := container.NewBorder(nil, nil, folderBtn, p.inPath, p.search)
	p.root = container.NewBorder(container.NewVBox(top, container.NewHBox(row...), p.pathBar), nil, nil, nil, p.table)
	return p
}

// ---------- Suche ----------

func (p *MPane) scheduleSearch() {
	gen := p.gen.Add(1)
	if p.debounce != nil {
		p.debounce.Stop()
	}
	p.debounce = time.AfterFunc(120*time.Millisecond, func() { p.runSearch(gen) })
}

func (p *MPane) runSearch(gen int64) {
	if gen != p.gen.Load() {
		return
	}
	if p.folderMode {
		p.loadFolder(p.folder, false)
		return
	}
	ix := p.app.ix
	q := Query{Text: p.search.Text, Filter: *p.filter(), InPath: p.inPath.Checked, MaxResult: maxResults}
	if ix == nil || (strings.TrimSpace(q.Text) == "" && q.Filter == 0) {
		p.ix, p.res = ix, nil
		p.rebuild()
		p.updateCounts(nil)
		return
	}
	start := time.Now()
	res, total, counts := ix.Search(q, func() bool { return gen != p.gen.Load() })
	if gen != p.gen.Load() {
		return
	}
	p.ix, p.res = ix, res
	p.applySort()
	p.rebuild()
	p.updateCounts(&counts)
	msg := fmt.Sprintf("%s Treffer (%d ms)", thousands(int64(total)), time.Since(start).Milliseconds())
	if total > len(res) {
		msg += " – nur die ersten " + thousands(int64(len(res))) + " werden angezeigt"
	}
	p.app.paneStatus(msg + "   |   " + p.app.lastInfo)
}

func (p *MPane) updateCounts(counts *[NumCats]int) {
	for c := CatPDF; c <= CatFolder; c++ {
		t := CatNames[c]
		if counts != nil {
			t += " (" + thousands(int64(counts[c])) + ")"
		}
		p.filters[c].Text = t
		p.filters[c].Refresh()
	}
}

func (p *MPane) sortBy(col int) {
	c, desc := p.sortCol()
	if *c == col {
		*desc = !*desc
	} else {
		*c, *desc = col, false
	}
	p.app.cfg.Save()
	p.applySort()
	p.rebuild()
}

func (p *MPane) applySort() {
	c, desc := p.sortCol()
	key := 0
	if *c >= 0 && *c < len(macColKey) {
		key = macColKey[*c]
	}
	if p.folderMode {
		sortFolderItems(p.items, key, !*desc)
	} else if p.ix != nil {
		p.ix.SortResults(p.res, key, !*desc)
	}
}

// rebuild baut die angezeigten Zeilen neu auf (alles zugeklappt).
func (p *MPane) rebuild() {
	v := make([]mrow, 0, len(p.res)+len(p.items))
	if p.folderMode {
		for i := range p.items {
			v = append(v, mrow{e: &p.items[i], dir: p.folder})
		}
	} else if p.ix != nil {
		for _, r := range p.res {
			e := &p.ix.Entries[r]
			v = append(v, mrow{e: e, dir: p.ix.Dirs[e.Dir]})
		}
	}
	p.view, p.selRow, p.dropRow = v, -1, -1
	p.table.Refresh()
}

func (p *MPane) path(row int) string {
	if row < 0 || row >= len(p.view) {
		return ""
	}
	return filepath.Join(p.view[row].dir, p.view[row].e.Name)
}

// ---------- Ordneransicht ----------

func (p *MPane) openFolder(dir string) {
	p.folderMode, p.folder = true, dir
	p.pathLabel.SetText(dir)
	p.pathBar.Show()
	p.loadFolder(dir, false)
}

func (p *MPane) loadFolder(dir string, silent bool) {
	go func() {
		ents, err := os.ReadDir(dir)
		if err != nil {
			if !silent {
				p.app.paneStatus("Ordner nicht lesbar: " + err.Error())
			}
			return
		}
		excl := map[string]bool{}
		for _, e := range p.app.cfg.Excludes {
			excl[strings.ToLower(e)] = true
		}
		filter := *p.filter() &^ FilterBit(CatFolder)
		var items []Entry
		var counts [NumCats]int
		for _, de := range ents {
			name := de.Name()
			if excl[strings.ToLower(name)] || strings.HasPrefix(name, ".") || strings.HasPrefix(name, sharedIndexName) {
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
			if filter != 0 && !e.IsDir && filter&FilterBit(cat) == 0 {
				continue
			}
			items = append(items, e)
		}
		if !p.folderMode || p.folder != dir {
			return
		}
		if silent && (p.app.drag != nil || sameItems(p.items, items)) {
			return
		}
		p.items = items
		p.applySort()
		p.rebuild()
		p.updateCounts(&counts)
		if !silent {
			p.app.paneStatus(fmt.Sprintf("%s: %d Einträge – Dateien hierher ziehen = verschieben (⌥ = kopieren)", dir, len(items)))
		}
	}()
}

func sameItems(a, b []Entry) bool {
	if len(a) != len(b) {
		return false
	}
	m := make(map[string]Entry, len(a))
	for _, e := range a {
		m[e.Name] = e
	}
	for _, e := range b {
		if o, ok := m[e.Name]; !ok || o.Size != e.Size || o.Mod != e.Mod {
			return false
		}
	}
	return true
}

func (p *MPane) goUp() {
	parent := filepath.Dir(p.folder)
	if p.folderMode && parent != p.folder {
		p.openFolder(parent)
	}
}

func (p *MPane) leaveFolder() {
	p.folderMode = false
	p.pathBar.Hide()
}

func (p *MPane) backToSearch() {
	p.leaveFolder()
	p.scheduleSearch()
	p.app.w.Canvas().Focus(p.search)
}

// ---------- Aktionen ----------

func (p *MPane) activate(row int) {
	if row < 0 || row >= len(p.view) {
		return
	}
	if p.view[row].e.IsDir {
		p.openFolder(p.path(row))
		return
	}
	openPath(p.path(row))
}

func (p *MPane) contextMenu(row int, pos fyne.Position) {
	path := p.path(row)
	if path == "" {
		return
	}
	isDir := p.view[row].e.IsDir
	dir := path
	if !isDir {
		dir = filepath.Dir(path)
	}
	other := p.app.panes[1-p.idx]
	items := []*fyne.MenuItem{
		fyne.NewMenuItem("Öffnen", func() { p.activate(row) }),
		fyne.NewMenuItem("Im Finder zeigen", func() { revealPath(path) }),
		fyne.NewMenuItem("In der anderen Ansicht öffnen", func() { p.app.setSecondPane(true); other.openFolder(dir) }),
		fyne.NewMenuItemSeparator(),
		fyne.NewMenuItem("Datei kopieren (zum Einfügen im Finder/Mail)", func() {
			if err := copyFileToClipboard(path); err != nil {
				p.app.setStatus("Kopieren nicht möglich: " + err.Error())
			} else {
				p.app.setStatus("Kopiert – mit ⌘V im Finder, in Mail usw. einfügen.")
			}
		}),
		fyne.NewMenuItem("Pfad kopieren", func() { p.app.w.Clipboard().SetContent(path) }),
		fyne.NewMenuItem("Name kopieren", func() { p.app.w.Clipboard().SetContent(filepath.Base(path)) }),
	}
	widget.ShowPopUpMenuAtPosition(fyne.NewMenu("", items...), p.app.w.Canvas(), pos)
}

// folderMenu: feste Ordner (z. B. Digitale Eingänge) und Startordner.
func (p *MPane) folderMenu(btn *widget.Button) {
	a := p.app
	var items []*fyne.MenuItem
	for _, f := range a.cfg.Favorites {
		f := f
		mi := fyne.NewMenuItem(f.Name, func() { p.openFolder(f.Path) })
		mi.Checked = p.folderMode && p.folder == f.Path
		items = append(items, mi)
	}
	if len(items) == 0 {
		mi := fyne.NewMenuItem("(noch keine festen Ordner)", nil)
		mi.Disabled = true
		items = append(items, mi)
	}
	items = append(items, fyne.NewMenuItemSeparator())
	cur := ""
	if p.folderMode {
		cur = p.folder
	}
	remember := fyne.NewMenuItem("Angezeigten Ordner als festen Ordner merken", func() {
		for _, f := range a.cfg.Favorites {
			if f.Path == cur {
				return
			}
		}
		a.cfg.Favorites = append(a.cfg.Favorites, Favorite{Name: filepath.Base(cur), Path: cur})
		a.cfg.Save()
		a.setStatus("„" + filepath.Base(cur) + "“ ist jetzt unter „Ordner ▼“ gespeichert.")
	})
	remember.Disabled = cur == ""
	sf := &a.cfg.StartFolder
	if p.idx == 1 {
		sf = &a.cfg.StartFolder2
	}
	start := fyne.NewMenuItem("Angezeigten Ordner beim Start hier öffnen", func() {
		if *sf == cur {
			*sf = ""
		} else {
			*sf = cur
		}
		a.cfg.Save()
	})
	start.Disabled = cur == ""
	start.Checked = cur != "" && *sf == cur
	items = append(items, remember, start)
	if len(a.cfg.Favorites) > 0 {
		var del []*fyne.MenuItem
		for i, f := range a.cfg.Favorites {
			i := i
			del = append(del, fyne.NewMenuItem(f.Name, func() {
				a.cfg.Favorites = append(a.cfg.Favorites[:i:i], a.cfg.Favorites[i+1:]...)
				a.cfg.Save()
			}))
		}
		rm := fyne.NewMenuItem("Festen Ordner entfernen", nil)
		rm.ChildMenu = fyne.NewMenu("", del...)
		items = append(items, rm)
	}
	pos := fyne.CurrentApp().Driver().AbsolutePositionForObject(btn).Add(fyne.NewPos(0, btn.Size().Height))
	widget.ShowPopUpMenuAtPosition(fyne.NewMenu("", items...), a.w.Canvas(), pos)
}

// ---------- Ziehen & Ablegen ----------

// dropFolder: wohin wird in dieser Ansicht abgelegt? Ordnerzeile unter der Maus oder geöffneter Ordner.
func (p *MPane) dropFolder() string {
	if p.dropRow >= 0 && p.dropRow < len(p.view) && p.view[p.dropRow].e.IsDir {
		return p.path(p.dropRow)
	}
	if p.folderMode {
		return p.folder
	}
	return ""
}

func (p *MPane) selectedPaths(row int) []string {
	if row >= 0 {
		return []string{p.path(row)}
	}
	return nil
}

// hover: Maus über einer Zeile (auch während des Ziehens).
func (p *MPane) hover(row int) {
	a := p.app
	if a.drag == nil {
		return
	}
	if row != p.dropRow {
		p.dropRow = row
		p.table.Refresh()
		a.updateDragStatus()
	}
	if row >= 0 && row < len(p.view) && p.view[row].e.IsDir && !p.view[row].open && row != p.hoverRow {
		p.hoverRow, p.hoverAt = row, time.Now()
		time.AfterFunc(springDelay+50*time.Millisecond, func() {
			if a.drag != nil && p.hoverRow == row && p.dropRow == row && time.Since(p.hoverAt) >= springDelay {
				p.expand(row)
			}
		})
	}
}

const springDelay = 600 * time.Millisecond

// expand klappt beim Ziehen die Unterordner einer Ordnerzeile darunter als Baum auf.
func (p *MPane) expand(row int) {
	if row < 0 || row >= len(p.view) || p.view[row].open {
		return
	}
	dir := p.path(row)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var kids []mrow
	for _, de := range ents {
		if de.IsDir() && !strings.HasPrefix(de.Name(), ".") && !strings.HasPrefix(de.Name(), "@") && !strings.HasPrefix(de.Name(), "#") {
			e := &Entry{Name: de.Name(), IsDir: true}
			kids = append(kids, mrow{e: e, dir: dir, depth: p.view[row].depth + 1})
		}
	}
	p.view[row].open = true
	if len(kids) == 0 {
		return
	}
	sortRows(kids)
	v := append([]mrow{}, p.view[:row+1]...)
	v = append(v, kids...)
	v = append(v, p.view[row+1:]...)
	p.view = v
	p.table.Refresh()
}

func sortRows(r []mrow) {
	for i := 1; i < len(r); i++ {
		for j := i; j > 0 && naturalLess(strings.ToLower(r[j].e.Name), strings.ToLower(r[j-1].e.Name)); j-- {
			r[j], r[j-1] = r[j-1], r[j]
		}
	}
}

func (a *MacApp) dragMove(src *MPane, row int, ev *fyne.DragEvent) {
	if a.drag == nil {
		paths := src.selectedPaths(row)
		if len(paths) == 0 {
			return
		}
		a.drag = &dragState{src: src, paths: paths}
	}
	a.drag.pos = ev.AbsolutePosition
	t := a.paneAt(ev.AbsolutePosition, true)
	if t != a.drag.target {
		if a.drag.target != nil {
			a.drag.target.setDropWhole(false)
		}
		a.drag.target = t
	}
	if t != nil {
		t.setDropWhole(t.dropRow < 0 && t.folderMode)
	}
	a.updateDragStatus()
}

func (a *MacApp) updateDragStatus() {
	d := a.drag
	if d == nil {
		return
	}
	if d.target == nil || d.target.dropFolder() == "" {
		a.setStatus("Hier ablegen geht nicht – erst einen Ordner öffnen (Doppelklick) oder auf einen Ordner ziehen.")
		return
	}
	verb := "VERSCHIEBEN"
	if a.optionDown {
		verb = "KOPIEREN"
	}
	a.setStatus("Loslassen = " + verb + " nach " + d.target.dropFolder() + "   (⌥ gedrückt halten = kopieren)")
}

func (a *MacApp) dragEnd() {
	d := a.drag
	a.drag = nil
	if d == nil {
		return
	}
	target := ""
	if d.target != nil {
		target = d.target.dropFolder()
	}
	for _, p := range a.panes {
		p.setDropWhole(false)
		p.dropRow, p.hoverRow = -1, -1
		collapsed := false
		for _, r := range p.view {
			if r.depth > 0 {
				collapsed = true
				break
			}
		}
		if collapsed {
			p.rebuild()
		} else {
			p.table.Refresh()
		}
	}
	if target == "" {
		a.setStatus(a.lastInfo)
		return
	}
	a.transfer(d.paths, target, !a.optionDown)
}

func (p *MPane) setDropWhole(on bool) {
	c := color.Color(color.Transparent)
	if on {
		c = color.NRGBA{0xCC, 0xE8, 0xFF, 0xFF}
	}
	if p.pathBg.FillColor != c {
		p.pathBg.FillColor = c
		p.pathBg.Refresh()
	}
}

// ---------- Tabellenzelle ----------

type cell struct {
	widget.BaseWidget
	p        *MPane
	row, col int
	bg       *canvas.Rectangle
	icon     *widget.Icon
	label    *widget.Label
}

func newCell(p *MPane) *cell {
	c := &cell{p: p, bg: canvas.NewRectangle(color.Transparent), icon: widget.NewIcon(nil), label: widget.NewLabel("")}
	c.label.Truncation = fyne.TextTruncateEllipsis
	c.ExtendBaseWidget(c)
	return c
}

func (c *cell) CreateRenderer() fyne.WidgetRenderer {
	return widget.NewSimpleRenderer(container.NewStack(c.bg, container.NewBorder(nil, nil, c.icon, nil, c.label)))
}

var (
	colFolderBG = color.NRGBA{0xFF, 0xF4, 0xD6, 0xFF}
	colTreeBG   = color.NRGBA{0xEA, 0xF3, 0xFC, 0xFF}
	colDropBG   = color.NRGBA{0xCC, 0xE8, 0xFF, 0xFF}
	colSelBG    = color.NRGBA{0x99, 0xC9, 0xF5, 0xFF}
)

func (c *cell) update(row, col int) {
	c.row, c.col = row, col
	p := c.p
	if row >= len(p.view) {
		return
	}
	r := p.view[row]
	e := r.e
	text := ""
	imp := widget.MediumImportance
	style := fyne.TextStyle{}
	switch col {
	case 0:
		text = e.Name
		if r.open {
			text = "▼ " + text
		}
		if r.depth > 0 {
			text = strings.Repeat("    ", r.depth-1) + "└─ " + text
		}
		if e.IsDir {
			style.Bold = true
		}
	case 1:
		text = typeLabel(e.Name, e.IsDir)
		switch categoryOf(strings.ToLower(e.Name), e.IsDir) {
		case CatPDF:
			imp = widget.DangerImportance
		case CatImage:
			imp = widget.SuccessImportance
		case CatOffice:
			imp = widget.HighImportance
		case CatFolder:
			imp = widget.WarningImportance
		}
	case 2:
		text = r.dir
	case 3:
		if !e.IsDir {
			text = formatSize(e.Size)
		}
	case 4:
		if e.Mod != 0 {
			text = time.Unix(e.Mod, 0).Format("02.01.2006 15:04")
		}
	}
	c.label.Text, c.label.Importance, c.label.TextStyle = text, imp, style
	if col == 0 {
		c.icon.SetResource(iconFor(e))
		c.icon.Show()
	} else {
		c.icon.Hide()
	}
	bg := color.Color(color.Transparent)
	switch {
	case row == p.dropRow:
		bg = colDropBG
	case row == p.selRow:
		bg = colSelBG
	case r.depth > 0:
		bg = colTreeBG
	case e.IsDir:
		bg = colFolderBG
	}
	c.bg.FillColor = bg
	c.label.Refresh()
	c.bg.Refresh()
}

func iconFor(e *Entry) fyne.Resource {
	if e.IsDir {
		return theme.FolderIcon()
	}
	switch categoryOf(strings.ToLower(e.Name), false) {
	case CatImage:
		return theme.FileImageIcon()
	case CatPDF, CatOffice:
		return theme.DocumentIcon()
	}
	return theme.FileIcon()
}

func (c *cell) Tapped(*fyne.PointEvent) {
	c.p.selRow = c.row
	c.p.app.panes[1-c.p.idx].selRow = -1
	c.p.table.Refresh()
}

func (c *cell) DoubleTapped(*fyne.PointEvent) { c.p.activate(c.row) }

func (c *cell) TappedSecondary(ev *fyne.PointEvent) {
	c.Tapped(ev)
	c.p.contextMenu(c.row, ev.AbsolutePosition)
}

func (c *cell) Dragged(ev *fyne.DragEvent) { c.p.app.dragMove(c.p, c.row, ev) }
func (c *cell) DragEnd()                   { c.p.app.dragEnd() }

func (c *cell) MouseIn(*desktop.MouseEvent)    { c.p.hover(c.row) }
func (c *cell) MouseMoved(*desktop.MouseEvent) { c.p.hover(c.row) }
func (c *cell) MouseOut() {
	if c.p.app.drag != nil && c.p.dropRow == c.row {
		c.p.dropRow = -1
		c.p.table.Refresh()
	}
}
