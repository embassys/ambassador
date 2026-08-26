# 0021 Central result normalization

Status: accepted

Date: 2026-08-26

## Problem

The development central MCP server advertises structured tool schemas but returns tool values as Python dictionary strings inside `structuredContent.result`. A successful verification therefore contains the only central JWT inside a string that is not valid JSON. The gateway cannot persist that JWT through its strict verification-object contract.

## Options

- Require native structured results from central. This remains the preferred contract but blocks the current development acceptance flow.
- Evaluate the string or invoke a Python parser. This accepts too much syntax, creates a code-execution risk, or adds another runtime and dependency.
- Parse only the JSON-like Python literal forms emitted by the current wrapper. This adds project-owned parsing code but keeps the accepted result and credential checks intact.

## Decision

When an upstream tool result contains exactly one `structuredContent.result` string and one text item with the same bytes, the gateway may normalize the string as JSON or as a bounded, data-only subset of Python literals: dictionaries with unique string keys, lists, quoted strings with explicit escapes, finite JSON-compatible numbers, `True`, `False`, and `None`. A top-level object replaces the wrapper; an array or scalar remains under `result` so MCP `structuredContent` remains object-shaped.

The parser does not execute Python or JavaScript. It selects one grammar for the complete value and rejects mixed JSON and Python syntax. It rejects names, calls, attributes, bytes, sets, tuples, comprehensions, comments, duplicate keys, unsupported escapes, excessive nesting, and trailing data. It applies duplicate-key and depth checks to both JSON and Python syntax before allocating nested values. Failed parses containing collection delimiters, call syntax, a comment prefix, or a quoted-literal prefix fail closed. The normalized result remains subject to the existing credential-leak checks. Result and mirrored-content `_meta` must be plain objects and cannot contain forbidden credential names, stored credential bytes, or newly issued verification credential bytes. Verification extracts its four required fields, accepts harmless response extensions, and discards those extensions after recursively checking them for credential names and issued-token bytes.

This is a compatibility measure for the development central wrapper, not a new preferred central contract. Native structured MCP results remain the target.

## Tradeoffs

The gateway now owns a small parser and its security tests. The parser accepts less than Python's full literal grammar, so a future central value may fail until central returns native structured data or this decision is reviewed. Response-size and nesting limits bound its work, and unsupported syntax never executes.

No framework, package, runtime, or build-tool choice changes. The implementation adds no dependency, has no license impact, and behaves the same on every supported Node platform. It does not change the npm package layout or public CLI.

## Approval

The user approved parsing string-wrapped central results to cover the current service behavior on 2026-08-26. No dependency was added.
