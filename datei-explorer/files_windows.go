//go:build windows

package main

import (
	"io/fs"
	"strings"
	"syscall"
)

// hiddenEntry: versteckte Dateien und Systemdateien (wie im Explorer ausgeblendet). Die Merkmale
// kommen aus dem Ordnerlesen selbst – kein zusätzlicher Zugriff aufs NAS je Datei.
func hiddenEntry(de fs.DirEntry) bool {
	name := de.Name()
	if strings.HasPrefix(name, "~$") || strings.EqualFold(name, "desktop.ini") || strings.EqualFold(name, "thumbs.db") {
		return true
	}
	info, err := de.Info()
	if err != nil {
		return false
	}
	if a, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		const hidden, system = 0x2, 0x4
		return a.FileAttributes&(hidden|system) != 0 && !strings.HasPrefix(name, "#")
	}
	return false
}
