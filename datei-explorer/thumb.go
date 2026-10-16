package main

// Miniaturen (Vorschaubilder) für die Symbolansicht und das Vorschaufenster – im Programm und in Chrome.

import (
	"image"
	"image/color"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/image/draw"
)

// Thumbnail liefert ein Vorschaubild (höchstens size×size, auf Weiß gelegt). Unter Windows sind das
// dieselben Miniaturen wie im Explorer (Bilder, PDF/Office-Seiten, sofern ein Anbieter installiert ist,
// sonst das große Symbol).
func Thumbnail(path string, size int) (image.Image, error) {
	if size < 16 {
		size = 16
	}
	if size > 1024 {
		size = 1024
	}
	type result struct {
		img image.Image
		err error
	}
	ch := make(chan result, 1)
	go func() {
		img, err := platformThumbnail(path, size)
		ch <- result{img, err}
	}()
	select {
	case r := <-ch:
		return r.img, r.err
	case <-time.After(20 * time.Second): // hängende Vorschau-Erweiterung oder langsames NAS
		return nil, errTimeout
	}
}

type thumbErr string

func (e thumbErr) Error() string { return string(e) }

const errTimeout = thumbErr("Vorschau dauert zu lange")

// fitImage verkleinert ein Bild auf höchstens size×size und legt es auf weißen Grund.
func fitImage(src image.Image, size int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return src
	}
	if w > size || h > size {
		if w >= h {
			h = h * size / w
			w = size
		} else {
			w = w * size / h
			h = size
		}
	}
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}

// textPreview: Anfang einer Textdatei für das Vorschaufenster ("" = keine Textdatei).
var textExts = map[string]bool{"txt": true, "csv": true, "log": true, "md": true, "json": true, "xml": true,
	"ini": true, "cfg": true, "bat": true, "cmd": true, "ps1": true, "html": true, "htm": true, "css": true,
	"js": true, "go": true, "py": true, "sql": true, "yml": true, "yaml": true, "tsv": true, "eml": true}

func isTextFile(name string) bool { return textExts[fileExt(strings.ToLower(name))] }

// decodeText macht aus den ersten Bytes einer Datei lesbaren Text (UTF-8, sonst Windows-1252).
func decodeText(b []byte) string {
	b = []byte(strings.TrimPrefix(string(b), "\ufeff"))
	if utf8.Valid(b) {
		return string(b)
	}
	// nur das letzte Zeichen ist abgeschnitten (Datei nach 32 KB gekürzt)?
	for k := 1; k <= 3 && k < len(b); k++ {
		if !utf8.FullRune(b[len(b)-k:]) && utf8.Valid(b[:len(b)-k]) {
			return string(b[:len(b)-k])
		}
	}
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c) // Latin-1 als Näherung für Windows-1252
	}
	return string(r)
}

// peekText: die ersten 32 KB einer Textdatei für das Vorschaufenster.
func peekText(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, 32<<10)
	n, _ := io.ReadFull(f, buf)
	return decodeText(buf[:n]), nil
}
