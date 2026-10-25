#Requires -RunAsAdministrator
param(
    [ValidateRange(1024,65535)][int]$Port = 3101,
    [string]$PythonPath = ''
)
$ErrorActionPreference = 'Stop'
if (-not $PythonPath) {
    $PythonPath = if ($env:DEEPSEEK_FRIEND_PYTHON) { $env:DEEPSEEK_FRIEND_PYTHON } else { (Get-Command python -ErrorAction Stop).Source }
}
$taskProgram = (Resolve-Path -LiteralPath $PythonPath).Path
$taskRuleName = 'DeepSeekFriend-WebUI-' + $Port
$taskRule = Get-NetFirewallRule -Name $taskRuleName -ErrorAction SilentlyContinue
if ($taskRule) {
    Set-NetFirewallRule -Name $taskRuleName -Enabled True -Direction Inbound -Action Allow -Program $taskProgram -Protocol TCP -LocalPort $Port -Profile Any
} else {
    New-NetFirewallRule -Name $taskRuleName -DisplayName ('DeepSeek Friend password WebUI TCP ' + $Port) -Enabled True -Direction Inbound -Action Allow -Program $taskProgram -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
}
Write-Output ('Enabled TCP ' + $Port + ' for ' + $taskProgram + ' (IPv4 and IPv6).')
