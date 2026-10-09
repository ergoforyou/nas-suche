//go:build windows

package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/lxn/walk"
)

// ---------- Tabellenmodell ----------

type ResultModel struct {
	walk.TableModelBase
	walk.SorterBase
	ix      *Index
	rows    []int
	sortCol int
	asc     bool
}

func (m *ResultModel) RowCount() int { return len(m.rows) }

func (m *ResultModel) Value(row, col int) interface{} {
	if row >= len(m.rows) {
		return ""
	}
	e := &m.ix.Entries[m.rows[row]]
	switch col {
	case 0:
		return e.Name
	case 1:
		return m.ix.Dirs[e.Dir]
	case 2:
		if e.IsDir {
			return "Ordner"
		}
		return formatSize(e.Size)
	case 3:
		if e.Mod == 0 {
			return ""
		}
		return time.Unix(e.Mod, 0).Format("02.01.2006 15:04")
	}
	return ""
}

func (m *ResultModel) Sort(col int, order walk.SortOrder) error {
	m.sortCol, m.asc = col, order == walk.SortAscending
	if m.ix != nil {
		m.ix.SortResults(m.rows, m.sortCol, m.asc)
	}
	m.PublishRowsReset()
	return m.SorterBase.Sort(col, order)
}

func (m *ResultModel) set(ix *Index, rows []int) {
	m.ix, m.rows = ix, rows
	if ix != nil && m.sortCol >= 0 {
		ix.SortResults(m.rows, m.sortCol, m.asc)
	}
	m.PublishRowsReset()
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
