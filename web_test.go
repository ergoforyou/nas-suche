package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"testing"
)

// Die Browser-Erweiterung muss bei jedem Update dieselbe Kennung und denselben Ordner behalten –
// sonst müssten alle Kollegen sie neu einrichten.
func TestErweiterungBleibtGleich(t *testing.T) {
	b, err := chromeExtension.ReadFile("chrome/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct{ Key string }
	json.Unmarshal(b, &m)
	der, err := base64.StdEncoding.DecodeString(m.Key)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	id := []byte(hex.EncodeToString(sum[:16]))
	for i, c := range id {
		if c >= 'a' {
			id[i] = 'a' + 10 + (c - 'a')
		} else {
			id[i] = 'a' + (c - '0')
		}
	}
	if string(id) != extensionID || extensionID != "nmgcgkmicmknekjhpdbebcmfpobglfch" {
		t.Errorf("Kennung der Erweiterung hat sich geändert: %s", id)
	}
	if nativeHostName != "de.ergoforyou.nassuche" {
		t.Errorf("Name des Hilfsprogramms geändert")
	}
	if !portableMode() && filepath.Base(extensionDir()) != "Chrome-Erweiterung" {
		t.Errorf("Ordner der Erweiterung geändert: %s", extensionDir())
	}
}
