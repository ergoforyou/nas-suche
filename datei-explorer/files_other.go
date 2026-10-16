//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Dateioperationen ohne Windows (nur zum Entwickeln und Testen der Browser-Oberfläche).

func moveItem(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyItem(src, dst); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

func copyItem(src, dst string) error {
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return copyPlainFile(src, dst, fi.Mode())
	}
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(t, 0o755)
		}
		return copyPlainFile(p, t, info.Mode())
	})
}

func copyPlainFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm()|0o600)
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

// hiddenEntry: versteckte Dateien (beginnen mit Punkt).
func hiddenEntry(de fs.DirEntry) bool { return strings.HasPrefix(de.Name(), ".") }

func copyFileToClipboard(p string) error { return fmt.Errorf("Zwischenablage nur unter Windows") }
