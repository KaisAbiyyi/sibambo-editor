param(
	[int]$RootPid,
	[string]$RootCreationUtc = '',
	[string]$ProfilePath = '',
	[int]$ExpectedParentPid = 0,
	[string]$RequestsFile = ''
)

$ErrorActionPreference = 'Stop'

function Normalize-PathValue([string]$Value) {
	if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
	return [System.IO.Path]::GetFullPath($Value.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant()
}

try {
	$batchMode = -not [string]::IsNullOrWhiteSpace($RequestsFile)
	if ($batchMode) {
		$batch = Get-Content -LiteralPath $RequestsFile -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($batch.schemaVersion -cne 'bomc-process-snapshot-batch-v1' -or $batch.requests -isnot [array] -or $batch.requests.Count -lt 1 -or $batch.requests.Count -gt 1024) { throw 'Invalid process snapshot batch schema or size.' }
		$ids = New-Object 'System.Collections.Generic.HashSet[string]'
		foreach ($request in $batch.requests) {
			if ($request.id -isnot [string] -or [string]::IsNullOrWhiteSpace($request.id) -or -not $ids.Add($request.id)) { throw 'Invalid or repeated process snapshot request ID.' }
			if (($request.pid -isnot [int] -and $request.pid -isnot [long]) -or $request.pid -le 0 -or $request.pid -gt [int]::MaxValue) { throw 'Invalid process snapshot PID.' }
			if (($request.parentPid -isnot [int] -and $request.parentPid -isnot [long]) -or $request.parentPid -lt 0 -or $request.parentPid -gt [int]::MaxValue -or $request.creationUtc -isnot [string] -or $request.profilePath -isnot [string]) { throw 'Invalid process snapshot identity fields.' }
		}
	}
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

	function Get-RootSnapshot([int]$RootPid, [string]$RootCreationUtc, [string]$ProfilePath, [int]$ExpectedParentPid) {
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
	return $result
	}
	if ($batchMode) {
		$snapshots = @()
		foreach ($request in $batch.requests) {
			$snapshots += [ordered]@{ id = $request.id; snapshot = (Get-RootSnapshot $request.pid $request.creationUtc $request.profilePath $request.parentPid) }
		}
		$result = [ordered]@{ schemaVersion = 'bomc-process-snapshot-batch-v1'; querySucceeded = $true; queryCount = 1; inspectionId = [guid]::NewGuid().ToString(); snapshots = @($snapshots); error = $null }
	} else { $result = Get-RootSnapshot $RootPid $RootCreationUtc $ProfilePath $ExpectedParentPid }
	ConvertTo-Json -InputObject $result -Depth 12 -Compress
} catch {
	if (-not [string]::IsNullOrWhiteSpace($RequestsFile)) {
		ConvertTo-Json -InputObject ([ordered]@{ schemaVersion = 'bomc-process-snapshot-batch-v1'; querySucceeded = $false; queryCount = 0; inspectionId = $null; snapshots = @(); error = $_.Exception.Message }) -Depth 8 -Compress
		exit 1
	}
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
