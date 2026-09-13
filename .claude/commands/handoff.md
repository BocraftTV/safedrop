---
description: Schreibt oder aktualisiert das Übergabe-Manifest für die nächste Session
---

Schreibe den Stand dieser Session nach `HANDOFF.md` im Projektwurzelverzeichnis.

Falls die Datei noch nicht existiert, lege sie an und beginne mit einem
Abschnitt "Worum es geht": zwei bis drei Sätze zum Projekt selbst, damit
eine Session ohne jeden Vorkontext versteht, was hier gebaut wird.

Falls sie existiert, ergänze sie – überschreibe nichts, was noch gilt,
und lösche Erledigtes aus "Offen" raus.

Struktur:

## Worum es geht
## Stand
Was funktioniert, mit Belegen: Testausgabe, Befehle, die durchlaufen.
## Zuletzt gemacht (Datum)
## Offen
Konkrete nächste Schritte, priorisiert.
## Entscheidungen
Was wir bewusst so und nicht anders gebaut haben, und warum.
Auch verworfene Alternativen – damit die nächste Session sie nicht
nochmal vorschlägt.
## Fallstricke
Was uns Zeit gekostet hat. Fehlermeldungen im Wortlaut.

Regeln:
- Nur schreiben, was tatsächlich passiert ist. Keine Vermutungen,
  keine Pläne als erledigt darstellen.
- Bei Unsicherheit über einen Punkt: als unsicher kennzeichnen.
- Prüfe vorher mit `git status` und `git diff --stat`, was wirklich
  geändert wurde, statt dich auf dein Gedächtnis zu verlassen.
- Kurz halten. Keine Codeblöcke außer Befehlen und Fehlermeldungen.