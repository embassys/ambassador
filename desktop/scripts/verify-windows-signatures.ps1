param(
  [Parameter(Mandatory=$true)][string]$PackageRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Thumbprint
)
$ErrorActionPreference = 'Stop'
$Extensions = @('.exe', '.dll', '.node')
$Files = @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Where-Object { $Extensions -contains $_.Extension })
if ($Files.Count -eq 0) { throw 'No packaged executables were found.' }
foreach ($File in $Files) {
  $Signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Thumbprint -ne $Thumbprint) {
    throw 'A packaged executable does not have the expected valid Authenticode signature.'
  }
}
