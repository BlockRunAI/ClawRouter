# ClawRouter Windows Test Script
# Tests installation, model registration, and model switching on Windows

Write-Host "🧪 Testing ClawRouter Model Selection (Windows)" -ForegroundColor Cyan
Write-Host "======================================`n"

# Test 1: Fresh install
Write-Host "→ Test 1: Fresh install (no existing config)" -ForegroundColor Yellow
Remove-Item -Recurse -Force "$env:USERPROFILE\.openclaw" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.openclaw" | Out-Null

Write-Host "  Installing ClawRouter..."
Write-Host "  (This may take up to 2 minutes...)"

$installOutput = openclaw plugins install "@blockrun/clawrouter@latest" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ FAIL: Plugin install failed" -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ Plugin installed`n" -ForegroundColor Green

# Test 2: Check config was created
Write-Host "→ Test 2: Verify config was created" -ForegroundColor Yellow
$configPath = "$env:USERPROFILE\.openclaw\openclaw.json"
if (-not (Test-Path $configPath)) {
    Write-Host "  ❌ FAIL: openclaw.json was not created" -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ Config file exists" -ForegroundColor Green

# Parse config and show BlockRun provider info
$config = Get-Content $configPath | ConvertFrom-Json
$blockrunProvider = $config.models.providers.blockrun
Write-Host "  BlockRun Provider:" -ForegroundColor Cyan
Write-Host "    baseUrl: $($blockrunProvider.baseUrl)"
Write-Host "    api: $($blockrunProvider.api)"
Write-Host "    modelCount: $($blockrunProvider.models.Count)`n"

# Test 3: Check models are available
Write-Host "→ Test 3: List available models" -ForegroundColor Yellow
$modelsOutput = openclaw models 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ FAIL: openclaw models command failed" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Models command succeeded`n" -ForegroundColor Green

# Test 4: Try to set a non-BlockRun model
Write-Host "→ Test 4: Switch to a non-BlockRun model" -ForegroundColor Yellow

# Add dummy OpenAI provider
$config = Get-Content $configPath | ConvertFrom-Json
if (-not $config.models) {
    $config | Add-Member -MemberType NoteProperty -Name "models" -Value @{} -Force
}
if (-not $config.models.providers) {
    $config.models | Add-Member -MemberType NoteProperty -Name "providers" -Value @{} -Force
}

$config.models.providers | Add-Member -MemberType NoteProperty -Name "openai" -Value @{
    baseUrl = "https://api.openai.com/v1"
    apiKey = "dummy-key"
    api = "openai-completions"
    models = @(
        @{
            id = "gpt-4"
            name = "GPT-4"
            api = "openai-completions"
            reasoning = $false
            input = @("text")
            cost = @{ input = 30; output = 60 }
        }
    )
} -Force

$config | ConvertTo-Json -Depth 10 | Set-Content $configPath
Write-Host "  Added dummy OpenAI provider"

# Manually set model (simulating user selection)
$config = Get-Content $configPath | ConvertFrom-Json
if (-not $config.agents) {
    $config | Add-Member -MemberType NoteProperty -Name "agents" -Value @{} -Force
}
if (-not $config.agents.defaults) {
    $config.agents | Add-Member -MemberType NoteProperty -Name "defaults" -Value @{} -Force
}
if (-not $config.agents.defaults.model) {
    $config.agents.defaults | Add-Member -MemberType NoteProperty -Name "model" -Value @{} -Force
}
$config.agents.defaults.model | Add-Member -MemberType NoteProperty -Name "primary" -Value "openai/gpt-4" -Force

$config | ConvertTo-Json -Depth 10 | Set-Content $configPath
Write-Host "  ✓ Switched to openai/gpt-4"

# Verify the change persisted
$config = Get-Content $configPath | ConvertFrom-Json
$model = $config.agents.defaults.model.primary
if ($model -ne "openai/gpt-4") {
    Write-Host "  ❌ FAIL: Model was not set to openai/gpt-4 (got: $model)" -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ Model selection persisted`n" -ForegroundColor Green

# Test 5: Verify model selection persists across 'openclaw models' runs
Write-Host "→ Test 5: Verify model selection persists across 'openclaw models' runs" -ForegroundColor Yellow
Write-Host "  Running 'openclaw models' again to simulate plugin reload..."
openclaw models | Out-Null

$config = Get-Content $configPath | ConvertFrom-Json
$modelAfter = $config.agents.defaults.model.primary
if ($modelAfter -ne "openai/gpt-4") {
    Write-Host "  ❌ FAIL: Model was changed back to $modelAfter (should still be openai/gpt-4)" -ForegroundColor Red
    Write-Host "  This is the BUG Chandler reported - plugin hijacking model selection!" -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ Model selection preserved (not hijacked by plugin)" -ForegroundColor Green
Write-Host ""

Write-Host "✅ All tests passed!" -ForegroundColor Green
Write-Host ""

Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  - Plugin installs without hanging"
Write-Host "  - Config is created correctly"
Write-Host "  - Models are available"
Write-Host "  - Can switch to non-BlockRun models"
Write-Host "  - Model selection persists after reload"
Write-Host ""
