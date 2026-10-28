<div align="center">
  <img src="docs/assets/banner.svg" alt="MnemoVault — memoria a largo plazo y afecto para DeepSeek Harness" width="100%">
</div>

<div align="center">

**Memoria a largo plazo y afecto para DeepSeek Harness.**
Las memorias se guardan como **celdas de tamaño fijo** — códigos dispersos (identidad), vectores int8
(semántica), hiperaristas tipadas (relaciones) y residuales comprimidos (texto original) —, no como texto.
La inyección rinde **~116 tokens por turno**.

[![CI](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](#inicio-rápido)
[![Tests](https://img.shields.io/badge/tests-93-brightgreen.svg)](test/)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3-4b6bfb.svg)](docs/API-CONTRACT.md)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español**

</div>

> Este README es el resumen en español. La **documentación en chino es la canónica**: allí están la
> justificación del diseño, las 15 debilidades conocidas y las cifras medidas
> ([`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) · [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md)).

| | |
| :--- | :--- |
| **Estado** | v0.2.0 · Developer Preview. Base: DSH `0.2.1-rc.3` (canal `next`); el propio host sigue introduciendo cambios incompatibles |
| **Tamaño** | 10 paquetes · 42 archivos fuente / 11.215 líneas de TS · 93 pruebas · **cero dependencias en ejecución** (solo `node:sqlite` y `node:zlib` integrados) |
| **Empieza por** | Mantenerlo → [guía del proyecto](docs/PROJECT-GUIDE.md) (en chino) / Modificarlo → [CONTRIBUTING](CONTRIBUTING.md) / Diseño → [documento de diseño](docs/design/MNEMOVAULT-DESIGN.md) |

---

## Por qué existe

La ventana de contexto es finita, y «lo que el usuario dijo hace tres meses» o no cabe o es demasiado caro.
La solución habitual es resumir la conversación en texto y recuperarla, pero los resúmenes son
**con pérdida e irreproducibles**: dos pasadas sobre el mismo diálogo difieren, y al resumir el original desaparece.

Aquí se toma otro camino:

1. **Lado de escritura**: divide el enunciado en proposiciones y codifica cada una en una celda de tamaño fijo:
   código disperso (identidad) + vector int8 (semántica) + hiperaristas tipadas (relaciones) +
   marcas de evento e invalidación (bitemporal) + lectura afectiva + cadena de versiones.
   El texto original se guarda aparte como residual brotli y siempre puede recuperarse byte a byte.
2. **Lado de lectura**: cuatro canales de recuperación (semántica / identidad / grafo / tiempo) se fusionan
   y una competencia de ranuras 4±1 decide qué se inyecta, renderizado como filas de tabla.
3. **Fuera de línea**: consolidación bifásica tipo sueño — NREM abstrae esquemas, REM cultiva asociaciones
   y una curva de olvido de ley de potencias degrada las celdas.
4. **El afecto es un parámetro, no un guion**: evaluación → PAD → ánimo → relación → ancla de persona,
   todo persistido como celdas normales: evolucionable y reversible.

## Lo que no es

- **No sustituye a RAG.** Recupera recuerdos *sobre una persona*, no documentos.
- **No reclama conciencia fenoménica.** Toda salida afectiva es una proyección de variables de estado;
  `affect_report` devuelve números y su propio descargo de responsabilidad.
- **No es un producto listo para usar.** Requiere un host DSH, que sigue en Developer Preview
  (rango soportado: `>=0.2.1-rc.3 <0.3.0`).
- **La extracción está limitada por reglas.** El puerto L1 (con modelo) existe, pero hoy solo corre la vía
  «mejorada por reglas». Es una debilidad declarada, no oculta.

## Flujo de datos

<div align="center">
  <img src="docs/assets/pipeline.svg" alt="Escritura, lectura y consolidación fuera de línea" width="100%">
</div>

La retícula es estado derivado: se reconstruye reproduciendo `session_log`, y cualquier recuperación
puede reproducirse byte a byte desde su instantánea.

---

## Inicio rápido

**Requisitos:** Node ≥ 22.5 (`node:sqlite` / `node:zlib` integrados) y npm ≥ 10.
**Las pruebas no necesitan DSH.**

```bash
npm ci               # solo devDependencies (typescript / react / tipos)
npm run build        # compila los 10 paquetes en orden de dependencia (tsc puro, sin bundler)
npm test             # 93 pruebas
npm run demo         # diálogo chino de 26 turnos: inyección / consolidación / estadísticas / guarda de salida
npm run bench:eval   # mnemo-bench: Recall@8 / MRR / deduplicación / razonamiento temporal / coste en tokens
npm run panel        # vista previa del panel lateral en http://127.0.0.1:5178/
npm run verify       # todo lo anterior en un solo comando (lo que ejecuta CI)
```

Aún no está publicado en npm (el scope `@bcf` está libre), así que se instala desde el código:

```bash
git clone https://github.com/Rain13Sad/bcf-mnemovault.git
cd bcf-mnemovault && npm ci && npm run build
```

Después inserta los plugins en tu perfil de DSH siguiendo el `cordis.patch.yml` de cada paquete.
La forma real de las interfaces del host —y en qué difiere del documento de diseño— está en
[`docs/API-CONTRACT.md`](docs/API-CONTRACT.md).

---

## Rendimiento medido

Medido en Node 22.22 / Windows; reproducible desde `artifacts/bench.json` (`npm run bench:eval`).

| Métrica | Medido | Objetivo | Nota |
| :--- | ---: | :--- | :--- |
| Recall@8 | **0.941** | ≥ 0.80 | 34 hechos sintéticos con verdad de referencia |
| MRR | **0.686** | ≥ 0.65 | ídem |
| Precisión de deduplicación | **0.90** | ≥ 0.90 | repetir un hecho debe fusionarse |
| Exhaustividad de deduplicación | **1.00** | — | mismo tema con otro valor no debe fusionarse |
| Razonamiento temporal | **1.00** | ≥ 0.75 | `pnpm → npm → bun` en tres versiones |
| tokens / turno | **116.0** | ≤ 240 | leyenda amortizada |
| p95 de recuperación | **30 ms** | ≤ 40 ms @1M | 100 celdas en local, no un millón |
| Ratio de almacenamiento (proposiciones cortas) | 24.1× | ≤ 0.60 | **no cumplido — ver abajo** |
| Ratio de almacenamiento (turno de 800 caracteres) | 2.50× | ≤ 0.60 | ídem |

<details>
<summary><b>Por qué falla el ratio de almacenamiento</b></summary>

Cada celda tiene una base fija de 192 B (cabecera) + 256 B (código disperso) + 256 B (vector) = **704 B**,
más un residual brotli de aproximadamente `0.42 ×` el texto. Por tanto `ratio ≈ (nCells × 750 + 0.42 × L) / L`.
La estimación del diseño asumía *una celda por turno*; el codificador divide por **proposición**, así que un
turno produce 2–4 celdas y la base fija se amplifica 2–4×. Es un hueco del documento de diseño, no un bug.
Mitigaciones (ninguna implementada): división más gruesa, cuantización de producto en la capa fría
(256 → 32 B), mover el embedding al nivel de turno.

</details>

---

## Paquetes

| Paquete | Rol |
| :--- | :--- |
| `@bcf/dsh-mnemo-core` | retícula, almacenamiento, recuperación, renderizado (`ctx.memory`) |
| `@bcf/dsh-mnemo-affect` | núcleo afectivo (`ctx.affect`) |
| `@bcf/dsh-mnemo-encoder` | escritura (se suscribe a `session/event`) |
| `@bcf/dsh-mnemo-recall` | lectura (compuerta e inyección en `agent/pre-step`) |
| `@bcf/dsh-mnemo-consolidator` | consolidación fuera de línea (NREM / REM / olvido) |
| `@bcf/dsh-mnemo-tools` | 6 herramientas · 15 subcomandos `/mnemo` · guarda de salida |
| `@bcf/dsh-mnemo-proactive` | hablar primero (cuatro compuertas) |
| `@bcf/dsh-mnemo-settings` | panel de ajustes y matriz de efecto |
| `@bcf/dsh-mnemo-ui` | panel lateral (lado cliente) |
| `@bcf/dsh-mnemo-devkit` | ejecutor sin host (`createHarness()`) |

El `inject` de Cordis se basa en dependencias: quien quiera memoria sin afecto instala solo
`core + encoder + recall + tools`, y `recall` degrada a una vía sin compuerta afectiva.

## Limitaciones conocidas

1. Solo corre la vía L1 «mejorada por reglas»; el puerto con modelo no está verificado en el host.
2. Los embeddings son hashes de n-gramas de caracteres: estables, no semánticos.
3. Sin HNSW (por debajo de 100k celdas el escaneo exacto es más rápido).
4. `ctx.remote` sin conectar. 5. La superficie de comandos depende de `ctx.cmdline`. 6. Sin conciencia fenoménica.
7. Sin cifrado en reposo: la base contiene conversaciones reales. Ver [SECURITY.md](SECURITY.md).

## Documentación

| Documento | Contenido |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | Mapa de la documentación (por intención) |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | Qué hace el código, 15 debilidades, 12 mejoras ordenadas P0–P2 |
| [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md) | Derivación completa del diseño |
| [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) | Diferencias con los paquetes reales de DSH `0.2.1-rc.3` |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md) | Contribución, historial, modelo de amenazas |

## Licencia

[MIT](LICENSE). Los informes de investigación y el documento de diseño bajo `docs/design/` pertenecen a
sus autores; esta implementación solo reproduce sus conclusiones de ingeniería.
