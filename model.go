//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"sort"
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
	onReset func() // erzwingt Neuzeichnen (walk invalidiert beim Zurücksetzen nicht alle Zeilen)

	folderMode bool
	folder     string  // angezeigter Ordner (Ordneransicht)
	items      []Entry // Inhalt des Ordners
}

func (m *ResultModel) reset() {
	m.PublishRowsReset()
	if m.onReset != nil {
		m.onReset()
	}
}

func (m *ResultModel) RowCount() int {
	if m.folderMode {
		return len(m.items)
	}
	return len(m.rows)
}

// entry liefert Eintrag und Ordner einer Zeile.
func (m *ResultModel) entry(row int) (*Entry, string) {
	if m.folderMode {
		if row < 0 || row >= len(m.items) {
			return nil, ""
		}
		return &m.items[row], m.folder
	}
	if row < 0 || row >= len(m.rows) || m.ix == nil {
		return nil, ""
	}
	e := &m.ix.Entries[m.rows[row]]
	return e, m.ix.Dirs[e.Dir]
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
		return e.Name
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
	m.reset()
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
	m.reset()
}

func (m *ResultModel) setFolder(dir string, items []Entry) {
	m.folderMode, m.folder, m.items = true, dir, items
	m.applySort()
	m.reset()
}

// sortFolderItems: Ordner immer zuerst, dann nach Spalte.
func sortFolderItems(items []Entry, col int, asc bool) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := &items[i], &items[j]
		if a.IsDir != b.IsDir {
			return a.IsDir
		}
		less := func(x, y *Entry) bool {
			switch col {
			case 2:
				if x.Size != y.Size {
					return x.Size < y.Size
				}
			case 3:
				if x.Mod != y.Mod {
					return x.Mod < y.Mod
				}
			case 4:
				if tx, ty := fileExt(strings.ToLower(x.Name)), fileExt(strings.ToLower(y.Name)); tx != ty {
					return tx < ty
				}
			}
			return naturalLess(strings.ToLower(x.Name), strings.ToLower(y.Name))
		}
		if asc {
			return less(a, b)
		}
		return less(b, a)
	})
}

func formatSize(n int64) string {
	f := float64(n)
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1<<20:
		return strings.Replace(fmt.Sprintf("%.1f KB", f/1024), ".", ",", 1)
	case n < 1<<30:
		return strings.Replace(fmt.Sprintf("%.1f MB", f/(1<<20)), ".", ",", 1)
	default:
		return strings.Replace(fmt.Sprintf("%.2f GB", f/(1<<30)), ".", ",", 1)
	}
}

func thousands(n int64) string {
	s := fmt.Sprint(n)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	return b.String()
}
