# Launch DARIA in dev mode with the native build environment configured.
#
#   .\dev.ps1                         # GPU if Vulkan SDK is present, else CPU-only
#   .\dev.ps1 --no-default-features   # force CPU-only
#
# Sets up the MSVC toolchain (cl/cmake/INCLUDE/LIB) and libclang (for the
# llama-cpp-sys-2 bindgen step), then runs `npm run tauri dev`. Extra args
# are forwarded to the Tauri CLI.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TauriArgs
)
$ErrorActionPreference = "Stop"

# 1. MSVC environment via vcvars64 (auto-located through vswhere).
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -property installationPath
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:\$($matches[1])" -Value $matches[2] }
}

# 2. libclang for bindgen. Override by setting $env:LIBCLANG_PATH before running.
function Find-LibclangDir {
    if ($env:LIBCLANG_PATH -and (Test-Path (Join-Path $env:LIBCLANG_PATH "libclang.dll"))) {
        return $env:LIBCLANG_PATH
    }
    $candidates = @(
        "${env:ProgramFiles}\LLVM\bin",
        "${env:ProgramFiles(x86)}\LLVM\bin"
    )
    $pyRoots = @(
        "$env:LOCALAPPDATA\Programs\Python",
        "$env:ProgramFiles\Python*"
    )
    foreach ($root in $pyRoots) {
        Get-Item $root -ErrorAction SilentlyContinue | ForEach-Object {
            $candidates += (Join-Path $_.FullName "Lib\site-packages\clang\native")
        }
    }
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir "libclang.dll")) { return $dir }
    }
    return $null
}
$libclang = Find-LibclangDir
if (-not $libclang) {
    throw "libclang.dll not found. Install LLVM (winget install LLVM.LLVM) or set LIBCLANG_PATH to the folder containing libclang.dll."
}
$env:LIBCLANG_PATH = $libclang
if ($env:PATH -notlike "*$libclang*") {
    $env:PATH = "$libclang;$env:PATH"
}

# 3. Vulkan SDK for the GPU (Vulkan) llama.cpp build. Auto-detect the newest
#    install under C:\VulkanSDK. Without it, default to a CPU-only cargo build.
if (-not $env:VULKAN_SDK) {
    $vk = Get-ChildItem "C:\VulkanSDK" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($vk) { $env:VULKAN_SDK = $vk.FullName }
}
if ($env:VULKAN_SDK) { $env:PATH = "$env:VULKAN_SDK\Bin;$env:PATH" }

# Tauri's CLI has --features but not --no-default-features. Cargo's flag has
# to go after `--` so the runner (cargo) sees it: `tauri dev -- --no-default-features`.
$tauriCli = @()
$cargoArgs = @()
foreach ($a in @($TauriArgs)) {
    if ($a -eq "--no-default-features") { $cargoArgs += $a }
    else { $tauriCli += $a }
}
$joined = (@($TauriArgs) -join " ")
$addsFeatures = $joined -match '--features(\s|=)|-F\s'
if (-not $env:VULKAN_SDK -and -not $addsFeatures -and -not ($cargoArgs -contains "--no-default-features")) {
    Write-Host "Vulkan SDK not found - building CPU-only (pass nothing extra; install the SDK for GPU)."
    $cargoArgs += "--no-default-features"
}

# 4. Short target dir + Ninja: the Vulkan llama.cpp build nests very deep
#    (vulkan-shaders-gen/...), so the default target path blows past Windows
#    MAX_PATH (260) and the shader compile fails with C1083. A short root fixes it.
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = "C:\ct" }
if (-not $env:CMAKE_GENERATOR) { $env:CMAKE_GENERATOR = "Ninja" }
$ninjaDirs = @(
    "C:\ProgramData\anaconda3\Library\bin",
    "$vsPath\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
)
if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) {
    foreach ($ninjaDir in $ninjaDirs) {
        if ((Test-Path "$ninjaDir\ninja.exe") -and ($env:PATH -notlike "*$ninjaDir*")) {
            $env:PATH = "$ninjaDir;$env:PATH"
            break
        }
    }
}

Write-Host "cmake    : $((Get-Command cmake -ErrorAction SilentlyContinue).Source)"
Write-Host "cl       : $((Get-Command cl    -ErrorAction SilentlyContinue).Source)"
Write-Host "ninja    : $((Get-Command ninja -ErrorAction SilentlyContinue).Source)"
Write-Host "libclang : $env:LIBCLANG_PATH"
Write-Host "vulkan   : $(if ($env:VULKAN_SDK) { $env:VULKAN_SDK } else { '(none - CPU-only)' })"
Write-Host ""

# Run the app (Vite dev server + Tauri window, hot-reloads on changes).
$npmArgs = @("run", "tauri", "--", "dev") + $tauriCli
if ($cargoArgs.Count -gt 0) {
    $npmArgs += "--"
    $npmArgs += $cargoArgs
}
& npm @npmArgs
