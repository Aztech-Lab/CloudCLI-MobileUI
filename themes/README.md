# Theme library

A **theme package** is the knowledge needed to make *any* user interface look like a given
design, written for whoever does the work next, a person or a coding agent. It is not a
stylesheet for this app: the app's stylesheet is one *output* of a package, recorded in the
package as an example.

A package answers three questions, in three files that are read in this order:

| file | question | form |
|---|---|---|
| `README.md` | What does it look like, and **why**? Intent, rules, things it never does. | prose, for people and agents |
| `theme.json` | What are the values? Colours, type, shape, texture, by **semantic role**. | machine-readable |
| `apply.md` | How do I put it on a UI I have never seen? Mapping, contrast, verification. | a procedure |

plus `examples/<target>.md`: a record of one real application (the decisions, the mapping
table, what needed adjusting), so the next application can start from precedent.

Rules for a package:

- Values are named by **role** (`surface.raised`, `ink.muted`, `signal.copper`), never by
  implementation (`--palette-blue-500`, `bg-gray-800`). Translating roles to a target's own
  variables is the application's job and is written down in its example.
- Every colour that is meant to carry text has a **text-safe** value that reaches 4.5:1 on
  the surfaces it is used on, stated separately from the fill value. Designs are usually
  drawn with fill tones; text is where applications go wrong.
- The package is self-contained: nothing in it refers to this repository's components. The
  examples do.

Packages:

- [`otsr/`](otsr/README.md): lab white and near-black with a copper signal, square corners
  and a few chamfered edges, monospace micro-labels. From the
  [OTSR](https://github.com/Aztech-Lab/OTSR) application and its technical report.
  Applied here as the `otsr` skin (`src/skins/otsr.css`; see
  [`otsr/examples/cloudcli.md`](otsr/examples/cloudcli.md)).
- [`aztecan/`](aztecan/README.md): near-black with a white halo, glass panels behind
  hairlines, a cyan signal, Inter, pill controls and a fine fading grid. From the
  [Aztech Labs website](https://aztecan.net/) (dark only; the light mode is derived).
  Applied here as the `aztecan` skin (`src/skins/aztecan.css`; see
  [`aztecan/examples/cloudcli.md`](aztecan/examples/cloudcli.md)).
