# Servidor estatico local para testar o prototipo: http://localhost:8765/
param([int]$Port = 8765)
$root = $PSScriptRoot
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.css' = 'text/css'; '.json' = 'application/json';
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.txt' = 'text/plain' }
$l = New-Object Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Servindo $root em http://localhost:$Port/"
while ($l.IsListening) {
  $ctx = $l.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($path -eq '') { $path = 'index.html' }
  $file = Join-Path $root $path
  $res = $ctx.Response
  try {
    if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($root))) {
      $bytes = [IO.File]::ReadAllBytes($file)
      if ($path -eq 'index.html' -and -not [Text.Encoding]::UTF8.GetString($bytes, 0, [math]::Min(15, $bytes.Length)).ToLower().StartsWith('<!doctype')) {
        # O artifact publicado recebe este cabecalho automaticamente; localmente ele e adicionado aqui.
        $head = [Text.Encoding]::UTF8.GetBytes('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0}</style></head><body>')
        $bytes = $head + $bytes
      }
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = $(if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' })
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else { $res.StatusCode = 404 }
  } catch { $res.StatusCode = 500 }
  $res.OutputStream.Close()
}
