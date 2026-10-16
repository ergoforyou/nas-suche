//go:build windows

package main

// Vorschaufenster (Alt+P) rechts in jeder Seite: großes Vorschaubild der markierten Datei
// (Bilder, PDF/Office-Seiten, sofern Windows dafür Miniaturen liefert), Textdateien als Text,
// dazu Typ, Größe, Datum und Ordner.

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/lxn/walk"
)

var procGetDoubleClickTime = user32.NewProc("GetDoubleClickTime")

func doubleClickTime() time.Duration {
	ms, _, _ := procGetDoubleClickTime.Call()
	if ms == 0 {
		ms = 500
	}
	return time.Duration(ms) * time.Millisecond
}

// prevSize: Größe der angeforderten Vorschau (Pixel).
func (p *Pane) prevSize() int {
	r := p.prevImg.ClientBoundsPixels()
	s := r.Width
	if r.Height > s {
		s = r.Height
	}
	switch {
	case s <= 256:
		return 256
	case s <= 512:
		return 512
	default:
		return 768
	}
}

func (p *Pane) updatePreview() {
	if p.search || p.prevBox == nil || !p.prevBox.Visible() {
		return
	}
	ents := p.selectedEntries()
	paths := p.selectedPaths()
	p.prevText.SetVisible(false)
	switch {
	case len(ents) == 0:
		p.prevPath, p.prevMod = "", 0
		p.prevName.SetText(filepath.Base(p.model.folder))
		p.prevInfo.SetText(fmt.Sprintf("Ordner mit %d Elementen\n%s", len(p.model.items), p.model.folder))
	case len(ents) > 1:
		var size int64
		for _, e := range ents {
			size += e.Size
		}
		p.prevPath, p.prevMod = "", 0
		p.prevName.SetText(fmt.Sprintf("%d Elemente ausgewählt", len(ents)))
		p.prevInfo.SetText("zusammen " + formatSize(size))
	default:
		e := ents[0]
		p.prevPath, p.prevMod = paths[0], e.Mod
		p.prevName.SetText(e.Name)
		info := typeLabel(e.Name, e.IsDir)
		if !e.IsDir {
			info += " · " + formatSize(e.Size)
		}
		if e.Mod != 0 {
			info += "\nGeändert: " + time.Unix(e.Mod, 0).Format("02.01.2006 15:04")
		}
		info += "\n" + filepath.Dir(paths[0])
		p.prevInfo.SetText(info)
		if !e.IsDir && isTextFile(e.Name) {
			path := paths[0]
			go func() {
				text, err := peekText(path)
				p.app.mw.Synchronize(func() {
					if err != nil || p.prevPath != path {
						return
					}
					p.prevText.SetText(normalizeNewlines(text))
					p.prevText.SetVisible(true)
				})
			}()
		}
	}
	p.prevImg.Invalidate()
}

// normalizeNewlines: das Textfeld von Windows braucht \r\n.
func normalizeNewlines(s string) string {
	out := make([]rune, 0, len(s)+len(s)/20)
	var prev rune
	for _, r := range s {
		if r == '\n' && prev != '\r' {
			out = append(out, '\r')
		}
		out = append(out, r)
		prev = r
	}
	return string(out)
}

var prevBack *walk.SolidColorBrush

func (p *Pane) paintPreview(c *walk.Canvas, _ walk.Rectangle) error {
	if prevBack == nil {
		prevBack, _ = walk.NewSolidColorBrush(walk.RGB(0xF6, 0xF8, 0xFA))
	}
	rc := p.prevImg.ClientBoundsPixels()
	c.FillRectanglePixels(prevBack, rc)
	if p.prevPath == "" {
		if ic := largeIcon("", true); ic != nil {
			s := 48 * p.prevImg.DPI() / 96
			c.DrawImageStretchedPixels(ic, walk.Rectangle{X: (rc.Width - s) / 2, Y: (rc.Height - s) / 2, Width: s, Height: s})
		}
		return nil
	}
	bmp, w, h := p.app.thumbFor(p.prevPath, p.prevMod, p.prevSize())
	if bmp == nil {
		return nil
	}
	// in die Fläche einpassen (nie vergrößern)
	sw, sh := w, h
	if sw > rc.Width {
		sh = sh * rc.Width / sw
		sw = rc.Width
	}
	if sh > rc.Height {
		sw = sw * rc.Height / sh
		sh = rc.Height
	}
	return c.DrawImageStretchedPixels(bmp, walk.Rectangle{X: (rc.Width - sw) / 2, Y: (rc.Height - sh) / 2, Width: sw, Height: sh})
}
