//go:build windows

package main

// Symbolansicht („Mittelgroße Symbole“ / „Große Symbole“): Kacheln mit den Miniaturen der Shell,
// selbst gezeichnet. Auswahl, Ziehen, Ablegen, Kontextmenü und Tasten wie in der Detailansicht.

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lxn/walk"
	"github.com/lxn/win"
)

type iconView struct {
	p   *Pane
	cw  *walk.CustomWidget
	sel map[int]bool
	cur int // Element mit dem Fokus
	anc int // Anker für Umschalt+Klick
	top int // Bildlauf in Pixeln

	dragArmed  bool
	downX      int
	downY      int
	downIdx    int
	lastClick  time.Time
	lastIdx    int
	pendSingle int
	sbDrag     bool // Bildlaufleiste wird gezogen
	sbOff      int
}

func newIconView(p *Pane) *iconView {
	return &iconView{p: p, sel: map[int]bool{}, cur: -1, anc: -1, downIdx: -1, pendSingle: -1}
}

// thumbPx: Kantenlänge der Miniatur in Pixeln (je nach Ansicht und Bildschirm-Skalierung).
func (v *iconView) thumbPx() int {
	base := 96
	if v.p.viewMode() == 2 {
		base = 192
	}
	return base * v.cw.DPI() / 96
}

func (v *iconView) cellSize() (w, h int) {
	t := v.thumbPx()
	d := v.cw.DPI()
	return t + 28*d/96, t + 52*d/96
}

func (v *iconView) cols() int {
	w, _ := v.cellSize()
	n := (v.cw.ClientBoundsPixels().Width - v.sbWidth()) / w
	if n < 1 {
		n = 1
	}
	return n
}

func (v *iconView) sbWidth() int { return 12 * v.cw.DPI() / 96 }

func (v *iconView) contentHeight() int {
	_, h := v.cellSize()
	n := v.p.model.RowCount()
	return (n + v.cols() - 1) / v.cols() * h
}

func (v *iconView) clampTop() {
	maxTop := v.contentHeight() - v.cw.ClientBoundsPixels().Height
	if v.top > maxTop {
		v.top = maxTop
	}
	if v.top < 0 {
		v.top = 0
	}
}

func (v *iconView) cellRect(i int) walk.Rectangle {
	w, h := v.cellSize()
	c := v.cols()
	return walk.Rectangle{X: (i % c) * w, Y: (i/c)*h - v.top, Width: w, Height: h}
}

// indexAt: Element unter einem Punkt (Fensterkoordinaten), -1 = freie Fläche.
func (v *iconView) indexAt(x, y int) int {
	w, h := v.cellSize()
	c := v.cols()
	if x < 0 || x >= c*w || y < 0 {
		return -1
	}
	i := (y+v.top)/h*c + x/w
	if i >= v.p.model.RowCount() {
		return -1
	}
	return i
}

func (v *iconView) indexAtScreen(x, y int32) int {
	pt := win.POINT{X: x, Y: y}
	win.ScreenToClient(v.cw.Handle(), &pt)
	rc := v.cw.ClientBoundsPixels()
	if pt.X < 0 || pt.Y < 0 || int(pt.X) >= rc.Width || int(pt.Y) >= rc.Height {
		return -1
	}
	return v.indexAt(int(pt.X), int(pt.Y))
}

func (v *iconView) selected() []int {
	var out []int
	for i := range v.sel {
		if i < v.p.model.RowCount() {
			out = append(out, i)
		}
	}
	sort.Ints(out)
	return out
}

func (v *iconView) setSelection(idx []int) {
	if len(idx) == len(v.sel) {
		same := true
		for _, i := range idx {
			same = same && v.sel[i]
		}
		if same { // unverändert (z. B. automatische Aktualisierung): nicht wegrollen
			v.cw.Invalidate()
			return
		}
	}
	v.sel = map[int]bool{}
	for _, i := range idx {
		v.sel[i] = true
	}
	if len(idx) > 0 {
		v.cur, v.anc = idx[0], idx[0]
		v.ensureVisible(idx[0])
	}
	v.changed()
}

func (v *iconView) changed() {
	v.cw.Invalidate()
	v.p.selectionChanged()
}

// modelReset: neuer Ordnerinhalt – ungültige Auswahl verwerfen.
func (v *iconView) modelReset() {
	n := v.p.model.RowCount()
	for i := range v.sel {
		if i >= n {
			delete(v.sel, i)
		}
	}
	if v.cur >= n {
		v.cur = n - 1
	}
	v.clampTop()
	v.cw.Invalidate()
}

func (v *iconView) ensureVisible(i int) {
	r := v.cellRect(i)
	hgt := v.cw.ClientBoundsPixels().Height
	if r.Y < 0 {
		v.top += r.Y
	} else if r.Y+r.Height > hgt {
		v.top += r.Y + r.Height - hgt
	}
	v.clampTop()
	v.cw.Invalidate()
}

// ---------- Zeichnen ----------

var (
	gridSelBrush, gridDropBrush, gridWhite, gridSbBrush, gridSbBack *walk.SolidColorBrush
	gridSelPen                                                      *walk.CosmeticPen
	gridFont                                                        *walk.Font
)

func (v *iconView) paint(c *walk.Canvas, upd walk.Rectangle) error {
	if gridWhite == nil {
		gridWhite, _ = walk.NewSolidColorBrush(walk.RGB(255, 255, 255))
		gridSelBrush, _ = walk.NewSolidColorBrush(walk.RGB(0xCC, 0xE4, 0xF7))
		gridDropBrush, _ = walk.NewSolidColorBrush(colorDropRow)
		gridSbBrush, _ = walk.NewSolidColorBrush(walk.RGB(0xB8, 0xC4, 0xD0))
		gridSbBack, _ = walk.NewSolidColorBrush(walk.RGB(0xF0, 0xF2, 0xF5))
		gridSelPen, _ = walk.NewCosmeticPen(walk.PenSolid, walk.RGB(0x7D, 0xB7, 0xE8))
		gridFont, _ = walk.NewFont("Segoe UI", 9, 0)
	}
	rc := v.cw.ClientBoundsPixels()
	c.FillRectanglePixels(gridWhite, rc)
	n := v.p.model.RowCount()
	_, ch := v.cellSize()
	cols := v.cols()
	first := v.top / ch * cols
	last := (v.top+rc.Height)/ch*cols + cols
	if last > n {
		last = n
	}
	t := v.thumbPx()
	dpi := v.cw.DPI()
	pad := 4 * dpi / 96
	for i := first; i < last; i++ {
		e, dir := v.p.model.entry(i)
		if e == nil {
			continue
		}
		r := v.cellRect(i)
		box := walk.Rectangle{X: r.X + pad, Y: r.Y + pad, Width: r.Width - 2*pad, Height: r.Height - 2*pad}
		switch {
		case i == v.p.dropRow:
			c.FillRectanglePixels(gridDropBrush, box)
		case v.sel[i]:
			c.FillRectanglePixels(gridSelBrush, box)
			c.DrawRectanglePixels(gridSelPen, box)
		}
		if i == v.cur && v.cw.Focused() && !v.sel[i] {
			c.DrawRectanglePixels(gridSelPen, box)
		}
		// Miniatur (oder Symbol, solange sie lädt)
		path := filepath.Join(dir, e.Name)
		area := walk.Rectangle{X: r.X + (r.Width-t)/2, Y: r.Y + 8*dpi/96, Width: t, Height: t}
		if bmp, w, h := v.p.app.thumbFor(path, e.Mod, t); bmp != nil {
			c.DrawImageStretchedPixels(bmp, walk.Rectangle{X: area.X + (t-w)/2, Y: area.Y + (t-h)/2, Width: w, Height: h})
		} else if ic := largeIcon(e.Name, e.IsDir); ic != nil {
			s := 32 * dpi / 96
			c.DrawImageStretchedPixels(ic, walk.Rectangle{X: area.X + (t-s)/2, Y: area.Y + (t-s)/2, Width: s, Height: s})
		}
		col := walk.RGB(0x1B, 0x27, 0x33)
		if len(v.p.app.cutPaths) > 0 && v.p.app.cutPaths[strings.ToLower(path)] {
			col = walk.RGB(0xA0, 0xA6, 0xAE)
		}
		txt := walk.Rectangle{X: r.X + 6*dpi/96, Y: area.Y + t + 4*dpi/96, Width: r.Width - 12*dpi/96, Height: 34 * dpi / 96}
		c.DrawTextPixels(e.Name, gridFont, col, txt, walk.TextCenter|walk.TextWordbreak|walk.TextEndEllipsis|walk.TextEditControl)
	}
	// schmale Bildlaufleiste rechts
	total := v.contentHeight()
	if total > rc.Height {
		sb := walk.Rectangle{X: rc.Width - v.sbWidth(), Y: 0, Width: v.sbWidth(), Height: rc.Height}
		c.FillRectanglePixels(gridSbBack, sb)
		th := rc.Height * rc.Height / total
		if th < 24 {
			th = 24
		}
		ty := v.top * (rc.Height - th) / (total - rc.Height)
		c.FillRectanglePixels(gridSbBrush, walk.Rectangle{X: sb.X + 2, Y: ty, Width: sb.Width - 4, Height: th})
	}
	if n == 0 {
		c.DrawTextPixels("Dieser Ordner ist leer.", gridFont, walk.RGB(0x60, 0x6B, 0x78),
			walk.Rectangle{X: 0, Y: 30 * dpi / 96, Width: rc.Width, Height: 30 * dpi / 96}, walk.TextCenter|walk.TextSingleLine)
	}
	return nil
}

// ---------- Maus ----------

func (v *iconView) init() {
	v.cw.SetClearsBackground(false)
	v.cw.MouseDown().Attach(v.mouseDown)
	v.cw.MouseMove().Attach(v.mouseMove)
	v.cw.MouseUp().Attach(v.mouseUp)
	v.cw.MouseWheel().Attach(func(x, y int, b walk.MouseButton) {
		delta := int(int16(uint32(b) >> 16))
		_, ch := v.cellSize()
		v.top -= delta * ch / 2 / 120
		v.clampTop()
		v.cw.Invalidate()
	})
	v.cw.SizeChanged().Attach(func() { v.clampTop(); v.cw.Invalidate() })
	v.cw.FocusedChanged().Attach(func() {
		if v.cw.Focused() {
			v.p.markActive()
		}
		v.cw.Invalidate()
	})
	RegisterDropTarget(uintptr(v.cw.Handle()), v.p)
}

func (v *iconView) onScrollbar(x int) bool {
	return v.contentHeight() > v.cw.ClientBoundsPixels().Height && x >= v.cw.ClientBoundsPixels().Width-v.sbWidth()
}

func (v *iconView) scrollTo(y int) {
	rc := v.cw.ClientBoundsPixels()
	total := v.contentHeight()
	if total <= rc.Height {
		return
	}
	th := rc.Height * rc.Height / total
	if th < 24 {
		th = 24
	}
	v.top = (y - v.sbOff) * (total - rc.Height) / maxi(1, rc.Height-th)
	v.clampTop()
	v.cw.Invalidate()
}

func maxi(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (v *iconView) mouseDown(x, y int, b walk.MouseButton) {
	v.cw.SetFocus()
	if b == walk.LeftButton && v.onScrollbar(x) {
		v.sbDrag = true
		rc := v.cw.ClientBoundsPixels()
		total := v.contentHeight()
		th := maxi(24, rc.Height*rc.Height/total)
		ty := v.top * (rc.Height - th) / maxi(1, total-rc.Height)
		v.sbOff = th / 2
		if y >= ty && y < ty+th {
			v.sbOff = y - ty
		}
		v.scrollTo(y)
		return
	}
	i := v.indexAt(x, y)
	ctrl, shift := walk.ControlDown(), walk.ShiftDown()
	v.pendSingle = -1
	if i < 0 {
		if !ctrl && !shift {
			v.sel = map[int]bool{}
			v.changed()
		}
		if b == walk.RightButton {
			v.p.app.mw.Synchronize(func() { v.p.contextMenu(false) })
		}
		return
	}
	if b == walk.RightButton {
		if !v.sel[i] {
			v.sel = map[int]bool{i: true}
			v.cur, v.anc = i, i
			v.changed()
		}
		v.p.app.mw.Synchronize(func() { v.p.contextMenu(false) })
		return
	}
	if b != walk.LeftButton {
		return
	}
	// Doppelklick selbst erkennen
	if i == v.lastIdx && time.Since(v.lastClick) < doubleClickTime() {
		v.lastClick = time.Time{}
		v.p.activate()
		return
	}
	v.lastClick, v.lastIdx = time.Now(), i
	switch {
	case ctrl:
		if v.sel[i] {
			delete(v.sel, i)
		} else {
			v.sel[i] = true
		}
		v.cur, v.anc = i, i
	case shift && v.anc >= 0:
		v.sel = map[int]bool{}
		lo, hi := v.anc, i
		if lo > hi {
			lo, hi = hi, lo
		}
		for k := lo; k <= hi; k++ {
			v.sel[k] = true
		}
		v.cur = i
	case v.sel[i]:
		v.pendSingle = i // erst beim Loslassen – damit man mehrere ziehen kann
		v.cur = i
	default:
		v.sel = map[int]bool{i: true}
		v.cur, v.anc = i, i
	}
	v.dragArmed, v.downX, v.downY, v.downIdx = true, x, y, i
	v.changed()
}

func (v *iconView) mouseMove(x, y int, b walk.MouseButton) {
	if v.sbDrag {
		if b&walk.LeftButton == 0 {
			v.sbDrag = false
			return
		}
		v.scrollTo(y)
		return
	}
	if !v.dragArmed || b&walk.LeftButton == 0 {
		return
	}
	dx, dy := x-v.downX, y-v.downY
	if dx*dx+dy*dy < 25 {
		return
	}
	v.dragArmed, v.pendSingle = false, -1
	v.p.startDrag()
}

func (v *iconView) mouseUp(x, y int, b walk.MouseButton) {
	v.sbDrag = false
	v.dragArmed = false
	if v.pendSingle >= 0 && v.indexAt(x, y) == v.pendSingle {
		v.sel = map[int]bool{v.pendSingle: true}
		v.anc = v.pendSingle
		v.changed()
	}
	v.pendSingle = -1
}

// ---------- Tasten (kommen über den Tastatur-Haken, siehe keyHook) ----------

func (v *iconView) key(vk uint32) bool {
	n := v.p.model.RowCount()
	cols := v.cols()
	_, ch := v.cellSize()
	page := maxi(1, v.cw.ClientBoundsPixels().Height/ch) * cols
	move := func(i int) bool {
		if n == 0 {
			return true
		}
		if i < 0 {
			i = 0
		}
		if i >= n {
			i = n - 1
		}
		if walk.ShiftDown() && v.anc >= 0 {
			v.sel = map[int]bool{}
			lo, hi := v.anc, i
			if lo > hi {
				lo, hi = hi, lo
			}
			for k := lo; k <= hi; k++ {
				v.sel[k] = true
			}
		} else {
			v.sel = map[int]bool{i: true}
			v.anc = i
		}
		v.cur = i
		v.ensureVisible(i)
		v.changed()
		return true
	}
	cur := v.cur
	switch vk {
	case win.VK_LEFT:
		return move(cur - 1)
	case win.VK_RIGHT:
		return move(cur + 1)
	case win.VK_UP:
		return move(cur - cols)
	case win.VK_DOWN:
		if cur < 0 {
			return move(0)
		}
		return move(cur + cols)
	case win.VK_PRIOR:
		return move(cur - page)
	case win.VK_NEXT:
		return move(cur + page)
	case win.VK_HOME:
		return move(0)
	case win.VK_END:
		return move(n - 1)
	case win.VK_RETURN:
		v.p.activate()
		return true
	case win.VK_DELETE, win.VK_F2, win.VK_F5, win.VK_BACK, win.VK_APPS, win.VK_F4:
		v.p.tableKey(walk.Key(vk))
		return true
	case win.VK_F10:
		if walk.ShiftDown() {
			v.p.contextMenu(true)
			return true
		}
	}
	if walk.ControlDown() {
		switch vk {
		case 'A', 'C', 'X', 'V', 'L', 'N':
			v.p.tableKey(walk.Key(vk))
			return true
		}
	}
	return false
}

// ---------- Miniaturen (Zwischenspeicher für Symbolansicht und Vorschaufenster) ----------

type thumbEntry struct {
	bmp  *walk.Bitmap
	w, h int
	fail bool
}

// thumbFor liefert die Miniatur, falls schon da – sonst wird sie im Hintergrund geholt
// und die Ansicht danach neu gezeichnet.
func (a *App) thumbFor(path string, mod int64, size int) (*walk.Bitmap, int, int) {
	if a.thumbs == nil {
		a.thumbs = map[string]*thumbEntry{}
	}
	key := fmt.Sprintf("%s|%d|%d", strings.ToLower(path), mod, size)
	if t, ok := a.thumbs[key]; ok {
		if t == nil || t.fail {
			return nil, 0, 0
		}
		return t.bmp, t.w, t.h
	}
	if len(a.thumbs) > 900 { // Speicher begrenzen
		for _, t := range a.thumbs {
			if t != nil && t.bmp != nil {
				t.bmp.Dispose()
			}
		}
		a.thumbs = map[string]*thumbEntry{}
	}
	a.thumbs[key] = nil // wird geladen
	go func() {
		img, err := Thumbnail(path, size)
		a.mw.Synchronize(func() {
			t := &thumbEntry{fail: true}
			if err == nil && img != nil {
				if bmp, e := walk.NewBitmapFromImageForDPI(img, 96); e == nil {
					b := img.Bounds()
					t = &thumbEntry{bmp: bmp, w: b.Dx(), h: b.Dy()}
				}
			}
			if a.thumbs != nil {
				a.thumbs[key] = t
			}
			for _, p := range a.panes {
				if p.grid != nil && p.grid.cw.Visible() {
					p.grid.cw.Invalidate()
				}
				if p.prevImg != nil && p.prevImg.Visible() {
					p.prevImg.Invalidate()
				}
			}
		})
	}()
	return nil, 0, 0
}

var largeIconCache = map[string]*walk.Icon{}

// largeIcon: großes Windows-Symbol des Dateityps (nur anhand der Endung, ohne NAS-Zugriff).
func largeIcon(name string, isDir bool) *walk.Icon {
	key, path, attr := "|dir", "ordner", uint32(0x10)
	if !isDir {
		key = fileExt(strings.ToLower(name))
		path, attr = "datei."+key, 0x80
	}
	if ic, ok := largeIconCache[key]; ok {
		return ic
	}
	var sfi win.SHFILEINFO
	var ic *walk.Icon
	flags := uint32(win.SHGFI_ICON | win.SHGFI_LARGEICON | win.SHGFI_USEFILEATTRIBUTES)
	if r := win.SHGetFileInfo(syscallUTF16(path), attr, &sfi, uint32(sizeofSHFILEINFO), flags); r != 0 && sfi.HIcon != 0 {
		ic, _ = walk.NewIconFromHICONForDPI(sfi.HIcon, 96)
	}
	largeIconCache[key] = ic
	return ic
}
