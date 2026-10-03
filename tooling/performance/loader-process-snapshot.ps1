param(
	[int]$RootPid,
	[string]$RootCreationUtc = '',
	[string]$ProfilePath = '',
	[int]$ExpectedParentPid = 0
)

$ErrorActionPreference = 'Stop'

function Normalize-PathValue([string]$Value) {
	if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
	return [System.IO.Path]::GetFullPath($Value.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant()
}

try {
	$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
	$byPid = @{}
	foreach ($process in $processes) {
		$creationUtc = $null
		if ($process.CreationDate) { $creationUtc = $process.CreationDate.ToUniversalTime().ToString('o') }
		$entry = [ordered]@{
			pid = [int]$process.ProcessId
			ppid = [int]$process.ParentProcessId
			creationUtc = $creationUtc
			executable = [string]$process.ExecutablePath
			commandLine = [string]$process.CommandLine
		}
		$byPid[[int]$process.ProcessId] = $entry
	}

	$root = $byPid[[int]$RootPid]
	$rootMatches = $false
	if ($root) {
		$rootMatches = $true
		if (-not [string]::IsNullOrWhiteSpace($RootCreationUtc)) {
			$rootMatches = $rootMatches -and ($root.creationUtc -ceq $RootCreationUtc)
		}
		if ($ExpectedParentPid -gt 0) {
			$rootMatches = $rootMatches -and ($root.ppid -eq $ExpectedParentPid)
		}
	}

	$descendants = @()
	if ($root -and $rootMatches) {
		$frontier = @([int]$RootPid)
		$seen = New-Object 'System.Collections.Generic.HashSet[int]'
		[void]$seen.Add([int]$RootPid)
		while ($frontier.Count -gt 0) {
			$next = @()
			foreach ($parentId in $frontier) {
				$parentEntry = $byPid[[int]$parentId]
				foreach ($candidate in $processes) {
					$candidatePid = [int]$candidate.ProcessId
					if ($seen.Contains($candidatePid) -or [int]$candidate.ParentProcessId -ne [int]$parentId) { continue }
					$candidateEntry = $byPid[$candidatePid]
					$parentBirth = [DateTime]::Parse($parentEntry.creationUtc).ToUniversalTime()
					$candidateBirth = [DateTime]::Parse($candidateEntry.creationUtc).ToUniversalTime()
					if ($candidateBirth -lt $parentBirth) { continue }
					[void]$seen.Add($candidatePid)
					$descendants += $candidateEntry
					$next += $candidatePid
				}
			}
			$frontier = $next
		}
	}

	$profileMatches = @()
	if (-not [string]::IsNullOrWhiteSpace($ProfilePath)) {
		$normalizedProfile = Normalize-PathValue $ProfilePath
		foreach ($entry in $byPid.Values) {
			$commandLine = [string]$entry.commandLine
			$pattern = '(?i)(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))(?=\s|$)'
			foreach ($match in [regex]::Matches($commandLine, $pattern)) {
				$argumentPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
				if ((Normalize-PathValue $argumentPath) -ceq $normalizedProfile) {
					$profileMatches += $entry
					break
				}
			}
		}
	}

	$result = [ordered]@{
		querySucceeded = $true
		root = $root
		rootIdentityMatches = [bool]$rootMatches
		descendants = @($descendants)
		profileMatches = @($profileMatches)
		error = $null
	}
	ConvertTo-Json -InputObject $result -Depth 8 -Compress
} catch {
	$result = [ordered]@{
		querySucceeded = $false
		root = $null
		rootIdentityMatches = $false
		descendants = @()
		profileMatches = @()
		error = $_.Exception.Message
	}
	ConvertTo-Json -InputObject $result -Depth 8 -Compress
	exit 1
}
