$ErrorActionPreference = 'Stop'
$payrollUrl = 'http://127.0.0.1:17862'
function Test-Payroll {
    try {
        $health = Invoke-RestMethod -Uri "$payrollUrl/health" -TimeoutSec 2
        return $health.app -eq 'Crispy King Local Payroll'
    } catch { return $false }
}
function Start-PayrollServer {
    $runtime = Join-Path $PSScriptRoot 'runtime\node.exe'
    $serverFile = Join-Path $PSScriptRoot 'server.cjs'
    $script:startedServer = Start-Process -FilePath $runtime -ArgumentList ('"' + $serverFile + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Payroll) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}
try {
    if (-not (Test-Payroll)) {
        $runtime = Join-Path $PSScriptRoot 'runtime\node.exe'
        $result = & $runtime (Join-Path $PSScriptRoot 'update-worker.cjs')
        $installed = $false
        if ($LASTEXITCODE -eq 0) {
            $installed = ($result | ConvertFrom-Json).applied -eq $true
        } else {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show('An update was postponed. Your existing payroll will open. Check License and updates for details.', 'Crispy King Payroll') | Out-Null
        }
        $running = Start-PayrollServer
        if (-not $running -and $installed) {
            # Stop only the exact child process started by this launcher.
            if (-not $script:startedServer.HasExited) { $script:startedServer.Kill(); $script:startedServer.WaitForExit() }
            & $runtime (Join-Path $PSScriptRoot 'update-worker.cjs') --rollback-last | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Update recovery needs support. Your payroll database was kept.' }
            $running = Start-PayrollServer
        }
        if (-not $running) { throw 'Could not start local payroll. Port 17862 may be in use.' }
    }
    if (-not (Test-Payroll)) { throw 'Could not start local payroll. Port 17862 may be in use.' }
    Start-Process $payrollUrl
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Crispy King Payroll')
}

# SIG # Begin signature block
# MIIHJAYJKoZIhvcNAQcCoIIHFTCCBxECAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCBOQcgwZPTHxUG1
# SLwyIk40nSWiIZq6SOX/4vUJOqU2yqCCBBQwggQQMIICeKADAgECAhBtpe1XZuBW
# qEHzMLvuS0SCMA0GCSqGSIb3DQEBCwUAMCAxHjAcBgNVBAMMFU1hcmsgQW50aG9u
# eSBULiBMb3BlejAeFw0yNjExMTkwMTQwMTZaFw0zMTExMTkwMTUwMTRaMCAxHjAc
# BgNVBAMMFU1hcmsgQW50aG9ueSBULiBMb3BlejCCAaIwDQYJKoZIhvcNAQEBBQAD
# ggGPADCCAYoCggGBAL9nvwMQkmuw8t5Pkk/UBJ0oW/okLyH/wC/88V190dqaio57
# CkQf2TgPW1hhbPR5sML2omFy87cKZ6lReMkTlX8Sdb3YC0JdWmoEsOCExFAfuHIe
# KXIk/FEBIRV0rAzGuaFOP7g3tdkgaXasHLzrYg3pi8zF2zNFFh8xmCQsnFTAlZHx
# lmAu4e4fu6bDNH/XyquD04cTtqzq/pObJjdxNVmWwZ3F11D5QGpROItmr/0LikCB
# 4iGc1hFGaLLmkznXFfOyBGiWBdsTfClFXZNtzHzQgtco3IyyRtBawpBL0cyVPhNc
# hppivOCN5oBbabmXsd2LBkkuB19pU4zpJrYuUZIO51DA+Sz+4tih0+l7lGvyzRzT
# BRN5mSWa9YDzOuuGa+hMc8LPbMBs5O6SDAg31uffV3xW295h4BuAsBG1+TgvQbLv
# hFbfi0bulhssKee8DENuepFMgEkRJhkibHTEXzggYYYvutH2L2wpF9bN4UQXyiSb
# wugZcClVrV9Lb5tH6QIDAQABo0YwRDAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAww
# CgYIKwYBBQUHAwMwHQYDVR0OBBYEFEjm5Y3KQUrMbw2pVTibJZ8Lu2loMA0GCSqG
# SIb3DQEBCwUAA4IBgQAwOpXc4XjSBOi7F66iBILIr86EjbXXI2VzoO3AU30zUMTb
# HL9qRV6UN11BBjc6MDH2JFZmT3RQT5PRbmvS49oPsu3ZachwgQY7xjBRn5Gpjauj
# 1ZtXDszPQ41neURbyckS4JZtaSaFvPgB7pMxinv0zMZmVxHHlAK2gqEY/eUIEsxY
# Q4Rh+7w30gjLQLQhAHyUmWXLldqzu/vHWGx57wBWkZo/3uiEYWcSv8shECM3NTkP
# LTl1PHQj8MtfJOmmnzhhdMXASkEFqNRdCso+KYOs4x005MW2wVruKG/9cQ0SsQLn
# fYYGvRnlBEmzr3mNktmcfDeEPixdxJIPtV7hyuhxP4nWWjGhiCt6QiBW4cwBbw9N
# Ed5t6Wte0Bd9YfIgFDQxWHwI/yTVq+5L7ZjaBxgFGXu62el8IeCDVzm2QqNTUPt5
# 8HX9+vol0iUbEZ82NTnahKKsoARE71MiiRUXfsAjhjHenEC5qQuhwV9Ioc97+9Kx
# QV6eytkZ3hSkVY3n+0YxggJmMIICYgIBATA0MCAxHjAcBgNVBAMMFU1hcmsgQW50
# aG9ueSBULiBMb3BlegIQbaXtV2bgVqhB8zC77ktEgjANBglghkgBZQMEAgEFAKCB
# hDAYBgorBgEEAYI3AgEMMQowCKACgAChAoAAMBkGCSqGSIb3DQEJAzEMBgorBgEE
# AYI3AgEEMBwGCisGAQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJ
# BDEiBCCXwC9E1P8DdWl4LjI4hWxaU0svdqlI+2RIrfo3P3sflzANBgkqhkiG9w0B
# AQEFAASCAYBtEtG1YoYnik1avgNE+1PmgHrnGheHxogRKTesHK0crfmF67BU5F9S
# GNIwO7llOCCVRpYLsdS/4Dzkp9ShBKJ/AxJPuqRb8PbSaEqI44WdacaZhPrfzO6R
# ywWCjafE1iTRdLcyXyUf34iU6PlkkuzcAytFWP242vj9CxJhwXTjIIc+Aa19UexY
# z6PDPGzk83iLCMd9ym1wT8EZ67HjSf31TeAr7a9RRa5yyIOXo02/8LiAQ/Do5zol
# 8XS/vWgzCUgA4R5ebWvUN+cRTrhyqPEmFKXFRDiuwngP5uJUr4TiKQVYXsVZmvhI
# WEbWbhomqIUKm9keByySr9T7inAo1ojf4dbi1lJ0sybk7i6/wJDYw9XmZ7MoLJol
# /J5zMmJEx7N7/akwmW7xCGRixbsHpv4YjQ/SjDDkAB6AOo432RDoL//7sfr1HZly
# LBigMydKJtb1R4H2QbbGy0+TMYb8bAf7skEfRe4/8H9pfyIoSVG3ODjRntFX2S4m
# G5Q7uMUFSXA=
# SIG # End signature block
