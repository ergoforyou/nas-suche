package main

// Gemeinsame Helfer für Windows- und Mac-Version.

import (
	"fmt"
	"sort"
	"strings"
)

var typeNames = map[string]string{
	"pdf": "PDF", "doc": "Word", "docx": "Word", "docm": "Word", "dot": "Word", "dotx": "Word", "odt": "Text (ODT)", "rtf": "Text (RTF)",
	"xls": "Excel", "xlsx": "Excel", "xlsm": "Excel", "xlsb": "Excel", "xlt": "Excel", "xltx": "Excel", "csv": "CSV", "ods": "Tabelle (ODS)",
	"ppt": "PowerPoint", "pptx": "PowerPoint", "pptm": "PowerPoint", "pps": "PowerPoint", "ppsx": "PowerPoint", "odp": "Präsentation",
	"msg": "E-Mail", "eml": "E-Mail", "vsd": "Visio", "vsdx": "Visio", "one": "OneNote",
	"jpg": "Bild (JPG)", "jpeg": "Bild (JPG)", "png": "Bild (PNG)", "gif": "Bild (GIF)", "bmp": "Bild (BMP)", "tif": "Bild (TIF)",
	"tiff": "Bild (TIF)", "heic": "Bild (HEIC)", "webp": "Bild (WEBP)", "svg": "Grafik (SVG)", "psd": "Photoshop",
	"zip": "ZIP-Archiv", "rar": "RAR-Archiv", "7z": "7-Zip-Archiv", "txt": "Text", "mp4": "Video", "mov": "Video",
	"mp3": "Audio", "wav": "Audio", "exe": "Programm", "dwg": "CAD (DWG)", "dxf": "CAD (DXF)",
}

func typeLabel(name string, isDir bool) string {
	if isDir {
		return "Ordner"
	}
	ext := fileExt(strings.ToLower(name))
	if t, ok := typeNames[ext]; ok {
		return t
	}
	if ext == "" {
		return "Datei"
	}
	return strings.ToUpper(ext) + "-Datei"
}

// sortFolderItems: Ordner immer zuerst, dann nach Spalte.
func sortFolderItems(items []Entry, col int, asc bool) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := &items[i], &items[j]
		if a.IsDir != b.IsDir && foldersFirst(col) {
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

func sameRoots(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(strings.TrimSpace(a[i]), strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}
