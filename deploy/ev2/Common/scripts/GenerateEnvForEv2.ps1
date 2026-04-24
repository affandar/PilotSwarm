function Update-EnvFileFromParametersJson {
    param (
        [string]$FilePath,               # Path to the .env file to update
        [string]$JsonFilePath            # Path to the JSON parameters file
    )

    if (-not (Test-Path $FilePath)) {
        Write-Error "File '$FilePath' does not exist."
        return
    }

    if (-not (Test-Path $JsonFilePath)) {
        Write-Error "JSON file '$JsonFilePath' does not exist."
        return
    }

    Write-Host "Reading .env file from: $FilePath"
    Write-Host "Reading parameter values from: $JsonFilePath"

    # Read the JSON file
    $jsonContent = Get-Content -Path $JsonFilePath -Raw | ConvertFrom-Json
    $parameterMap = @{}
    foreach ($param in $jsonContent.Parameters) {
        $parameterMap[$param.name] = $param.value
    }

    # Debug print all key-value pairs from the JSON file
    Write-Host "Debug: Parameters from JSON file:"
    foreach ($key in $parameterMap.Keys) {
        Write-Host "  Key: $key, Value: $($parameterMap[$key])"
    }

    # Read the .env file
    $envFileContent = Get-Content -Path $FilePath -Encoding UTF8

    # Initialize an array to store the updated .env file content
    $updatedEnvFileContent = @()

    # Iterate over each line in the file
    foreach ($line in $envFileContent) {
        # Skip empty lines or comments
        if ($line -match "^\s*$" -or $line -match "^\s*#") {
            Write-Host "Skipping line (empty or comment): $line"
            $updatedEnvFileContent += $line
            continue
        }

        # Parse the key-value pair
        if ($line -match "^(?<key>[^=]+)=(?<value>.*)$") {
            $key = $matches['key']
            $originalValue = $matches['value']

            if ($parameterMap.ContainsKey($key)) {
                $jsonValue = $parameterMap[$key]
                Write-Host "Found parameter for key '$key'. Replacing value '$originalValue' with '$jsonValue'."
                $updatedEnvFileContent += "$key=$jsonValue"
            } else {
                Write-Warning "No parameter found for key '$key'. Keeping original value: '$originalValue'."
                $updatedEnvFileContent += "$key=$originalValue"
            }
        } else {
            # If the line doesn't match the key=value format, keep it as is
            Write-Warning "Line does not match key=value format. Keeping as is: $line"
            $updatedEnvFileContent += $line
        }
    }

    # Overwrite the original file with the updated content
    Write-Host "Writing updated .env file back to: $FilePath"
    $updatedEnvFileContent | Set-Content -Path $FilePath -Encoding UTF8

    Write-Host "Update complete. .env file has been updated in place."
}
