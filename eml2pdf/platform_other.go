//go:build !windows && !darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Linux-Variante: dient zum Testen (keine Installation, Meldungen auf der Konsole).

func showInfo(title, text string)    { fmt.Printf("[%s]\n%s\n", title, text) }
func showWarning(title, text string) { fmt.Printf("[%s – Warnung]\n%s\n", title, text) }

func downloadsFolder() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Downloads")
}

func showResult(title, text, folder string, warning bool) { showInfo(title, text) }
func isInstalledCopy() bool                               { return true }
func askYesNo(title, text string) bool                    { showInfo(title, text); return false }
func chooseFolder(prompt, start string) (string, bool)    { return start, false }
func installApp()                                         { fmt.Println("Installation gibt es nur unter Windows und macOS.") }
func uninstallApp()                                       { installApp() }
func mainMenu(outDir string)                              { showInfo(appName+" "+version, "Zielordner: "+outDir) }
