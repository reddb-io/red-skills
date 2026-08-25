---
"@reddb-io/redskilled-mobile": minor
---

The app holds a fleet: the paired-host store becomes a list (v1 single-host record migrates on first read; adding a second Host never forgets the first; corrupt entries lose only themselves), every Host gets its own card judged on its own polling evidence, Worker rows aggregate across Hosts and stay labeled by the machine that owns them (stop routes to that Host), dispatch targets the tapped Host, and hosts can be unpaired from the device.
