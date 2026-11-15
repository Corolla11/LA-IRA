# Prepara o pacote de dados do prototipo (area 3x3 blocos HiRISE em volta do boxwork, Gale).
# Saida em .\data : elev.txt, hirise.jpg, hillshade.jpg, themis.png, crism_*.png, traverse.json, meta.json
# Uso: powershell -ExecutionPolicy Bypass -File .\preparar_dados.ps1   (Windows, precisa de internet)
Add-Type -AssemblyName System.Drawing
$ProgressPreference = 'SilentlyContinue'
$data = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Force $data | Out-Null

# Area: 15x15 tiles do zoom 16 (3x3 blocos de 5x5), centrada no tile 34518/115554
$d16 = 180 / [math]::Pow(2, 16)
$row0 = 34518 - 7; $col0 = 115554 - 7
$lonW = $col0 * $d16 - 180; $lonE = ($col0 + 15) * $d16 - 180
$latN = 90 - $row0 * $d16; $latS = 90 - ($row0 + 15) * $d16
$bb = "$lonW,$latS,$lonE,$latN"
$N = 1000
$is = 'https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer'

function Save-Jpeg($bmp, $path, $q) {
  $enc = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $p = New-Object Drawing.Imaging.EncoderParameters 1
  $p.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([long]$q)
  $bmp.Save($path, $enc, $p)
}

# 1. Altitude float32 (BSQ do ImageServer: N*N floats + mascara de 1 bit, que e descartada)
$tmp = Join-Path $env:TEMP 'elev_proto.bsq'
Invoke-WebRequest "$is/exportImage?bbox=$bb&bboxSR=104905&size=$N,$N&format=bsq&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image" -OutFile $tmp -UseBasicParsing
$by = [IO.File]::ReadAllBytes($tmp)
$out = New-Object byte[] ($N * $N * 4)
[Array]::Copy($by, $out, $out.Length)
# Gravado em base64 (.txt), porque a publicacao como artifact nao serve arquivos .bin
[IO.File]::WriteAllText((Join-Path $data 'elev.txt'), [Convert]::ToBase64String($out), [Text.Encoding]::ASCII)
$mask = $by[($N * $N * 4)..($by.Length - 1)] | Where-Object { $_ -ne 255 } | Measure-Object
"elev.txt ok ($N x $N float32 em base64), bytes de mascara diferentes de 0xFF: $($mask.Count)"

# 2. HiRISE: baixa os 15x15 tiles do zoom 16 (Mars Trek) e junta num mosaico 3840x3840
$big = New-Object Drawing.Bitmap 3840, 3840
$g = [Drawing.Graphics]::FromImage($big)
$tile = Join-Path $env:TEMP 'hirise_tile.png'
for ($r = 0; $r -lt 15; $r++) {
  for ($c = 0; $c -lt 15; $c++) {
    Invoke-WebRequest "https://trek.nasa.gov/tiles/Mars/EQ/curiosity_hirise_mosaic/1.0.0/default/default028mm/16/$($row0 + $r)/$($col0 + $c).png" -OutFile $tile -UseBasicParsing
    $im = [Drawing.Image]::FromFile($tile); $g.DrawImage($im, $c * 256, $r * 256, 256, 256); $im.Dispose()
  }
}
$g.Dispose(); Save-Jpeg $big (Join-Path $data 'hirise.jpg') 78; $big.Dispose()
"hirise.jpg ok (225 tiles)"

# 3. Relevo sombreado (Hillshade do ImageServer)
$rr = [uri]::EscapeDataString('{"rasterFunction":"Hillshade","rasterFunctionArguments":{"Azimuth":315,"Altitude":45,"ZFactor":1}}')
Invoke-WebRequest "$is/exportImage?bbox=$bb&bboxSR=104905&size=2000,2000&format=jpg&f=image&renderingRule=$rr" -OutFile (Join-Path $data 'hillshade.jpg') -UseBasicParsing
"hillshade.jpg ok"

# 4. THEMIS noturno: recorte exato da area no tile 9/269/902 (pixels x 182-211, y 158-187)
$t = Join-Path $env:TEMP 'themis_proto.png'
Invoke-WebRequest 'https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0/default/default028mm/9/269/902.png' -OutFile $t -UseBasicParsing
$src = [Drawing.Bitmap]::FromFile($t)
$px = (180 / 512) / 256
$x0 = [int][math]::Round(($lonW + 180 - 902 * (180 / 512)) / $px); $y0 = [int][math]::Round((90 - $latN - 269 * (180 / 512)) / $px)
$w = [int][math]::Round(($lonE - $lonW) / $px)
$crop = New-Object Drawing.Bitmap $w, $w
for ($y = 0; $y -lt $w; $y++) { for ($x = 0; $x -lt $w; $x++) { $crop.SetPixel($x, $y, $src.GetPixel($x0 + $x, $y0 + $y)) } }
$crop.Save((Join-Path $data 'themis.png'), [Drawing.Imaging.ImageFormat]::Png); $crop.Dispose(); $src.Dispose()
"themis.png ok (recorte $w x $w a partir de $x0,$y0)"

# 5. Trajetoria do Curiosity dentro da area (com folga)
$j = (Invoke-WebRequest 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json' -UseBasicParsing).Content | ConvertFrom-Json
$m = 0.004
$pts = $j.features | ForEach-Object { $_.properties } |
  Where-Object { $_.lat -ge ($latS - $m) -and $_.lat -le ($latN + $m) -and $_.lon -ge ($lonW - $m) -and $_.lon -le ($lonE + $m) } |
  Sort-Object { [int]$_.sol } |
  ForEach-Object { '[{0},{1},{2}]' -f [int]$_.sol, ([double]$_.lat).ToString('0.######', [Globalization.CultureInfo]::InvariantCulture), ([double]$_.lon).ToString('0.######', [Globalization.CultureInfo]::InvariantCulture) }
('[' + (@($pts) -join ',') + ']') | Set-Content -Encoding utf8 (Join-Path $data 'traverse.json')
"traverse.json ok ($(@($pts).Count) pontos)"

# 6. CRISM MTRDR FRT0000B6F1 (2008, 18 m/pixel): browse PHY, HYD, CAR e cor (TRU), recortados na area
$cb = 'https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/browse/2008/2008_191/frt0000b6f1/frt0000b6f1_07_br'
$lbl = (Invoke-WebRequest "${cb}hydj_mtr3.lbl" -UseBasicParsing).Content
function LblVal($name) { [double]([regex]::Match($lbl, "$name\s*=\s*([-\d.]+)").Groups[1].Value) }
$res = LblVal 'MAP_RESOLUTION'; $cW = LblVal 'WESTERNMOST_LONGITUDE'; $cN = LblVal 'MAXIMUM_LATITUDE'
$cx0 = [int][math]::Floor(($lonW - $cW) * $res); $cx1 = [int][math]::Ceiling(($lonE - $cW) * $res)
$cy0 = [int][math]::Floor(($cN - $latN) * $res); $cy1 = [int][math]::Ceiling(($cN - $latS) * $res)
$crw = $cx1 - $cx0; $crh = $cy1 - $cy0   # (PowerShell ignora maiusculas: nao usar $cw, que seria o mesmo que $cW)
foreach ($k in 'phy', 'hyd', 'car', 'tru') {
  $t = Join-Path $env:TEMP "crism_$k.png"
  Invoke-WebRequest "${cb}${k}j_mtr3.png" -OutFile $t -UseBasicParsing
  $src = [Drawing.Bitmap]::FromFile($t)
  $c = New-Object Drawing.Bitmap $crw, $crh, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($c)
  $g.DrawImage($src, (New-Object Drawing.Rectangle 0, 0, $crw, $crh), (New-Object Drawing.Rectangle $cx0, $cy0, $crw, $crh), [Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $c.Save((Join-Path $data "crism_$k.png"), [Drawing.Imaging.ImageFormat]::Png); $c.Dispose(); $src.Dispose()
}
$crism = [ordered]@{ produto = 'FRT0000B6F1_07 MTRDR'; lonW = $cW + $cx0 / $res; lonE = $cW + $cx1 / $res; latN = $cN - $cy0 / $res; latS = $cN - $cy1 / $res; w = $crw; h = $crh }
"crism ok ($crw x $crh pixels de 18 m)"

# 7. Metadados
[ordered]@{ lonW = $lonW; lonE = $lonE; latN = $latN; latS = $latS; N = $N; themisSize = $w; crism = $crism } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $data 'meta.json')
Get-ChildItem $data | Select-Object Name, @{n = 'KB'; e = { [math]::Round($_.Length / 1KB) } } | Format-Table -AutoSize | Out-String
"bbox: $bb"
