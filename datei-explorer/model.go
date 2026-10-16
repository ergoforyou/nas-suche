//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/lxn/walk"
)

// ---------- Tabellenmodell ----------

// ResultModel zeigt entweder Suchtreffer aus dem Index oder den Inhalt eines Ordners.
type ResultModel struct {
	walk.TableModelBase
	walk.SorterBase
	ix      *Index
	rows    []int
	sortCol int
	asc     bool
	onReset func()                  // erzwingt Neuzeichnen (walk invalidiert beim Zurücksetzen nicht alle Zeilen)
	onSort  func(col int, asc bool) // merkt sich die gewählte Sortierung

	folderMode bool
	folder     string  // angezeigter Ordner (Ordneransicht)
	items      []Entry // Inhalt des Ordners

	view     []vrow // angezeigte Zeilen inkl. beim Ziehen aufgeklappter Unterordner
	expanded bool   // mindestens ein Ordner ist aufgeklappt
}

// vrow ist eine angezeigte Zeile. depth > 0 = beim Ziehen aufgeklappter Unterordner (Baum).
type vrow struct {
	e     *Entry
	dir   string
	depth int
	open  bool
}

// rebuild baut die Anzeige aus den Treffern bzw. dem Ordnerinhalt neu auf (alles zugeklappt).
func (m *ResultModel) rebuild() {
	m.expanded = false
	m.view = m.view[:0]
	if m.folderMode {
		for i := range m.items {
			m.view = append(m.view, vrow{e: &m.items[i], dir: m.folder})
		}
		return
	}
	if m.ix == nil {
		return
	}
	for _, r := range m.rows {
		e := &m.ix.Entries[r]
		m.view = append(m.view, vrow{e: e, dir: m.ix.Dirs[e.Dir]})
	}
}

// expandRow klappt unter einem Ordner seine Unterordner als Baum auf.
func (m *ResultModel) expandRow(row int, subdirs []string) {
	if row < 0 || row >= len(m.view) || m.view[row].open {
		return
	}
	parent := m.view[row]
	m.view[row].open = true
	m.expanded = true
	dir := filepath.Join(parent.dir, parent.e.Name)
	kids := make([]Entry, len(subdirs))
	ins := make([]vrow, len(subdirs))
	for i, s := range subdirs {
		kids[i] = Entry{Name: s, IsDir: true}
		ins[i] = vrow{e: &kids[i], dir: dir, depth: parent.depth + 1}
	}
	m.view = append(m.view[:row+1], append(ins, m.view[row+1:]...)...)
	m.reset()
}

// collapseAll klappt alles wieder zu.
func (m *ResultModel) collapseAll() {
	if m.expanded {
		m.rebuild()
		m.reset()
	}
}

func (m *ResultModel) isOpen(row int) bool { return row >= 0 && row < len(m.view) && m.view[row].open }
func (m *ResultModel) depthOf(row int) int {
	if row < 0 || row >= len(m.view) {
		return 0
	}
	return m.view[row].depth
}

func (m *ResultModel) reset() {
	m.PublishRowsReset()
	if m.onReset != nil {
		m.onReset()
	}
}

func (m *ResultModel) RowCount() int { return len(m.view) }

// entry liefert Eintrag und Ordner einer Zeile.
func (m *ResultModel) entry(row int) (*Entry, string) {
	if row < 0 || row >= len(m.view) {
		return nil, ""
	}
	return m.view[row].e, m.view[row].dir
}

func (m *ResultModel) path(row int) string {
	e, dir := m.entry(row)
	if e == nil {
		return ""
	}
	return filepath.Join(dir, e.Name)
}

func (m *ResultModel) Value(row, col int) interface{} {
	e, dir := m.entry(row)
	if e == nil {
		return ""
	}
	switch col {
	case 0:
		v := m.view[row]
		name := e.Name
		if v.open {
			name = "▼ " + name
		}
		if v.depth > 0 {
			name = strings.Repeat("      ", v.depth-1) + "   └─ " + name
		}
		return name
	case 1:
		return typeLabel(e.Name, e.IsDir)
	case 2:
		return dir
	case 3:
		if e.IsDir {
			return ""
		}
		return formatSize(e.Size)
	case 4:
		if e.Mod == 0 {
			return ""
		}
		return time.Unix(e.Mod, 0).Format("02.01.2006 15:04")
	}
	return ""
}

// Tabellenspalte → Sortierschlüssel (siehe Index.SortResults)
var colSortKey = []int{0, 4, 1, 2, 3}

func (m *ResultModel) Sort(col int, order walk.SortOrder) error {
	m.sortCol, m.asc = 0, order == walk.SortAscending
	if col >= 0 && col < len(colSortKey) {
		m.sortCol = colSortKey[col]
	}
	m.applySort()
	m.rebuild()
	m.reset()
	if m.onSort != nil {
		m.onSort(col, m.asc)
	}
	return m.SorterBase.Sort(col, order)
}

func (m *ResultModel) applySort() {
	if m.folderMode {
		sortFolderItems(m.items, m.sortCol, m.asc)
	} else if m.ix != nil && m.sortCol >= 0 {
		m.ix.SortResults(m.rows, m.sortCol, m.asc)
	}
}

func (m *ResultModel) set(ix *Index, rows []int) {
	m.folderMode, m.items = false, nil
	m.ix, m.rows = ix, rows
	m.applySort()
	m.rebuild()
	m.reset()
}

func (m *ResultModel) setFolder(dir string, items []Entry) {
	m.folderMode, m.folder, m.items = true, dir, items
	m.applySort()
	m.rebuild()
	m.reset()
}
