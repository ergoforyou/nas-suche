//go:build windows

package main

import (
	_ "embed"

	"github.com/lxn/walk"
)

// Branding an einer Stelle – Name, Slogan und Farben hier anpassen.
const (
	brandName    = "ERGOFORYOU"
	brandProduct = "NAS-Suche"
	brandSlogan  = "Wenn es schnell gehen muss."
)

var (
	brandDark   = walk.RGB(0x10, 0x2A, 0x43)
	brandLight  = walk.RGB(0x1F, 0x6F, 0xB2)
	brandAccent = walk.RGB(0xFF, 0xBE, 0x28)
)

//go:embed assets/Montserrat-SemiBold.ttf
var fontSemiBold []byte

//go:embed assets/Montserrat-Regular.ttf
var fontRegular []byte

type banner struct {
	big, small, hint *walk.Font
	accent           *walk.SolidColorBrush
	hintText         string
}

func newBanner() *banner {
	LoadFontFromMemory(fontSemiBold)
	LoadFontFromMemory(fontRegular)
	b := &banner{}
	var err error
	if b.big, err = walk.NewFont("Montserrat SemiBold", 20, 0); err != nil {
		b.big, _ = walk.NewFont("Segoe UI Semibold", 20, 0)
	}
	if b.small, err = walk.NewFont("Montserrat", 10, 0); err != nil {
		b.small, _ = walk.NewFont("Segoe UI", 10, 0)
	}
	b.hint, _ = walk.NewFont("Segoe UI", 9, 0)
	b.accent, _ = walk.NewSolidColorBrush(brandAccent)
	return b
}

func (b *banner) paint(cw **walk.CustomWidget) walk.PaintFunc {
	return func(c *walk.Canvas, _ walk.Rectangle) error {
		r := (*cw).ClientBoundsPixels()
		c.GradientFillRectanglePixels(brandDark, brandLight, walk.Horizontal, r)
		dpi := (*cw).DPI()
		px := func(v int) int { return v * dpi / 96 }

		// Akzentbalken links
		c.FillRectanglePixels(b.accent, walk.Rectangle{X: 0, Y: 0, Width: px(6), Height: r.Height})

		x := px(20)
		white := walk.RGB(255, 255, 255)
		fmtV := walk.TextLeft | walk.TextVCenter | walk.TextSingleLine
		// Breite grob nach Zeichenzahl (Montserrat SemiBold 20 pt ≈ 21 px je Großbuchstabe),
		// die Textmessung der Bibliothek liefert hier keine verlässlichen Werte.
		w := len([]rune(brandName)) * px(21)
		c.DrawTextPixels(brandName, b.big, white, walk.Rectangle{X: x, Y: 0, Width: w + px(30), Height: r.Height}, fmtV)
		x += w + px(20)

		// zwei Zeilen: Produkt / Slogan
		half := r.Height / 2
		c.DrawTextPixels(brandProduct, b.small, white,
			walk.Rectangle{X: x, Y: half - px(19), Width: px(400), Height: px(18)}, walk.TextLeft|walk.TextSingleLine)
		c.DrawTextPixels(brandSlogan, b.small, walk.RGB(0xFF, 0xD7, 0x7A),
			walk.Rectangle{X: x, Y: half + px(1), Width: px(400), Height: px(18)}, walk.TextLeft|walk.TextSingleLine)

		if b.hintText != "" {
			c.DrawTextPixels(b.hintText, b.hint, walk.RGB(0xD6, 0xE6, 0xF5),
				walk.Rectangle{X: r.Width / 2, Y: 0, Width: r.Width/2 - px(16), Height: r.Height},
				walk.TextRight|walk.TextVCenter|walk.TextSingleLine|walk.TextEndEllipsis)
		}
		return nil
	}
}
