param(
    [switch]$CompileOnly
)

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed with exit code $LASTEXITCODE."
    }

    $generatedDirectories = @('out')
    foreach ($directory in $generatedDirectories) {
        $directoryPath = Join-Path $PSScriptRoot $directory
        if (Test-Path -LiteralPath $directoryPath) {
            Remove-Item -LiteralPath $directoryPath -Recurse -Force
        }
    }

    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.vsix' -File |
        Remove-Item -Force

    if ($CompileOnly) {
        npm run compile
        if ($LASTEXITCODE -ne 0) {
            throw "Compilation failed with exit code $LASTEXITCODE."
        }
    }
    else {
        npm run package
        if ($LASTEXITCODE -ne 0) {
            throw "Packaging failed with exit code $LASTEXITCODE."
        }
    }

}
finally {
    Pop-Location
}