# CLAUDE.md

Contexto para o Claude Code trabalhar neste repositório.

## Projeto
**Ares - Integrated route assistant** (repositório A-IRA). Desafio NASA Space Apps "Martian Map": ferramenta para um astronauta planejar uma EVA na superfície de Marte usando dados da NASA.

- **Objetivo científico:** investigar as formações boxwork (cristas de 1–2 m formadas por água subterrânea) no Monte Sharp, cratera Gale.
- **Área:** 2,46 × 2,46 km, lat −4,8285 a −4,7873, lon 137,3593 a 137,4005 (3×3 blocos de 5×5 tiles HiRISE do zoom 16, centrados no tile linha 34518 / coluna 115554).
- **Ponto de referência:** posição do Curiosity no sol 4670 (26/09/2025): lat −4,8082, lon 137,3811.
- Todo o texto da interface e da documentação é em português do Brasil.

## Estrutura
- `prototipo/index.html`: o app inteiro (HTML + CSS + JS sem framework, Leaflet 1.9.4 local em `prototipo/lib`).
- `prototipo/data/`: dados já preparados (não editar à mão; regerar com o script).
- `prototipo/preparar_dados.ps1`: baixa e recorta todos os dados das fontes da NASA (~1 min, Windows).
- `prototipo/serve.ps1`: servidor estático local (`http://localhost:8765/`). Abrir o HTML direto do disco não funciona (fetch dos dados).

## Fontes de dados
| Dado | Fonte |
|---|---|
| Imagem HiRISE | Mars Trek WMTS `curiosity_hirise_mosaic`, zoom 16 |
| Altitude (DTM 1 m) | Mars Trek ImageServer `Gale_DEM_SMG_1m`, exportImage `format=bsq&pixelType=F32` (N×N floats, depois uma máscara de 1 bit que é descartada) |
| Relevo sombreado | Mesmo ImageServer, rasterFunction `Hillshade` |
| Térmico | Mars Trek `THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018`, tile 9/269/902, recorte x 182–211, y 158–187 |
| Minerais | PDS Geosciences, CRISM MTRDR `frt0000b6f1_07` browse `br{phy,hyd,car,tru}j_mtr3.png` (equirretangular, 3293,04 px/grau) |
| Trajetória | `https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json` |
| Radiação | Curiosity RAD (PDS PPI `MSL-M-RAD-3-RDR-V1.0`), dose E média de 6,55 µGy/h nos sóis 4669–4673 |
| Catálogo de camadas | `https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems?start=0&rows=2147483647&facetKeys=itemType&facetValues=product` |

Grade de tiles do Mars Trek (equirretangular): `coluna = floor((lon+180)/360 × 2^(z+1))`, `linha = floor((90−lat)/180 × 2^z)`.

## Modelo de rota (no `index.html`)
- Grade de 1000×1000 células (~2,4 m). Declive pelo método de Horn.
- Custo de cada passo = tempo: função de Tobler normalizada `v = v0·e^(−3,5|s+0,05|+0,175)`, distância 3D.
- Bloqueios: célula com declive > limite (25°), declive lateral > 20°. Penalidade de 15° até o limite: `×(1+2(θ−15)/10)`. Areia (30% mais frios do THEMIS): `×1,5`.
- A* com heurística `distância / (1,19·v0)` (admissível). Cache de trechos por par de células e limites.
- Ordem das paradas por força bruta (até 6 paradas). Dijkstra a partir do habitat para o tempo de volta e a simulação de evento solar.
- Radiação estimada = 6,55 µGy/h × fração de céu visível (horizonte em 16 direções, raio ~390 m) ÷ a do ponto do rover.
- Duração da EVA, reserva e tempo por parada só mudam o cronograma (`refreshTimes()`); não rodam o A*.
- Todos os limites e velocidades são premissas ajustáveis na interface.

## Cuidados já aprendidos
- **PowerShell ignora maiúsculas em nomes de variáveis**: `$cW` e `$cw` são a mesma variável (já causou bug no recorte do CRISM).
- Esta máquina não tem Python nem Node; o Git fica em `C:\Program Files\Git\cmd\git.exe` (fora do PATH em algumas sessões).
- A versão publicada como artifact do claude.ai não serve arquivos `.bin`, por isso a altitude vai em base64 (`elev.txt`). Lá o `index.html` é publicado sem `<!doctype>`/`<head>` (o artifact adiciona); a cópia neste repositório é um documento HTML completo. As duas precisam ser mantidas em sincronia.
- Commits deste usuário: nome `Joaaquim1801`, e-mail noreply do GitHub (configurado só no repositório). Não usar o e-mail pessoal.
- Repositório do time: fazer `git fetch` antes de enviar ao `main`.
