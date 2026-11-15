# A-IRA
Ares - Integrated route assistant

Ferramenta de planejamento de EVA (caminhada fora do habitat) para um astronauta em Marte, feita para o desafio NASA Space Apps. O protótipo cobre uma área de 2,46 × 2,46 km na região das formações boxwork do Monte Sharp, cratera Gale, explorada pelo Curiosity em 2025.

## O que o protótipo faz

- Mapa HiRISE (~0,6 m/pixel) com camadas que podem ser ligadas e desligadas:
  - declive do DTM HiRISE (cautela e bloqueado);
  - minerais do CRISM (sulfatos, argilas, carbonatos);
  - radiação estimada;
  - térmico noturno do THEMIS;
  - tempo de volta ao habitat;
  - trajetória real do Curiosity (sóis 4374 a 5073).
- Rota com A* sobre uma grade de 1000 × 1000 células (~2,4 m), com custo em tempo de caminhada:
  - velocidade pela função de Tobler adaptada;
  - limites de declive na direção do passo e lateral;
  - penalidade em declives de cautela e em areia.
- Ordem de visita otimizada entre as paradas e cache do A*, para recalcular só os trechos novos.
- Linha do tempo da EVA com tempo de parada editável por ponto, duração da EVA e reserva de segurança.
- Controle da quantidade de pontos de interesse (1 a 6). Os pontos sugeridos vêm do HiRISE, do Curiosity e dos sinais de sulfato mais fortes do CRISM.
- Simulação de evento solar: mostra a volta mais rápida ao habitat a partir do pior ponto da rota.
- Funciona sem internet depois de carregado (dados e Leaflet ficam na pasta).

## Como rodar

O app precisa ser aberto por um servidor local (abrir o `index.html` direto do disco bloqueia a leitura dos dados).

Windows (PowerShell):

```powershell
cd prototipo
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

Depois abra http://localhost:8765/

Em qualquer sistema com Python:

```bash
cd prototipo
python -m http.server 8765
```

## Como regerar os dados

O script baixa tudo das fontes da NASA e recria a pasta `prototipo/data` em menos de 1 minuto:

```powershell
cd prototipo
powershell -ExecutionPolicy Bypass -File .\preparar_dados.ps1
```

| Arquivo | Fonte | Uso |
|---|---|---|
| `hirise.jpg` | Mars Trek, `curiosity_hirise_mosaic`, zoom 16 (15 × 15 tiles) | Mapa base |
| `elev.txt` | Mars Trek ImageServer, `Gale_DEM_SMG_1m` (float32 em base64) | Altitude, declive, rota, radiação |
| `hillshade.jpg` | Mesmo DTM, função Hillshade | Relevo sombreado |
| `themis.png` | Mars Trek, `THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018`, zoom 9 | Térmico noturno e areia |
| `crism_*.png` | PDS Geosciences, CRISM MTRDR `FRT0000B6F1_07` (browse HYD, PHY, CAR, TRU) | Minerais e pontos sugeridos |
| `traverse.json` | `mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json` | Trajetória do Curiosity |

A taxa de dose de 6,55 µGy/h vem do Curiosity RAD (PDS PPI, `MSL-M-RAD-3-RDR-V1.0`, dose E dos sóis 4669 a 4673).

## Premissas e limites

- Velocidade de traje, limites de declive (25° na direção do passo, 20° lateral), fator de areia, duração da EVA (6 h), reserva (30%) e tempo por parada (20 min) são premissas ajustáveis no app.
- Células de ~2,4 m: pedras e degraus menores que ~3 m não aparecem.
- O mapa de radiação é uma estimativa: a dose medida pelo RAD num ponto, multiplicada pela fração de céu visível calculada no DTM.
- O CRISM tem 18 m/pixel e o alinhamento com o HiRISE é aproximado.
- O THEMIS tem ~100 m/pixel; a classificação de areia é regional.
- O evento solar é simulado. Na missão real, o alerta viria do DONKI (api.nasa.gov).

## Créditos

Imagens e dados: NASA/JPL-Caltech/University of Arizona (HiRISE), NASA/JPL-Caltech/JHUAPL (CRISM), NASA/JPL-Caltech/ASU (THEMIS), NASA/JPL-Caltech/SwRI (RAD), via NASA Mars Trek e NASA PDS. Mapa: [Leaflet](https://leafletjs.com) 1.9.4.
