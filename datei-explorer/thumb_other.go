//go:build !windows

package main

import (
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
)

// platformThumbnail ohne Windows: nur Bilder (zum Testen der Browser-Oberfläche).
func platformThumbnail(path string, size int) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}
	return fitImage(img, size), nil
}
