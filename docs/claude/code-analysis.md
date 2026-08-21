<!-- Generated from the asol-docs skill templates. Edit at source
     (asol-docs/templates/claude/code-analysis.md), not here — the drift report
     flags local edits as divergence. -->

# Code Analysis Guidelines

Best practice for analysing a large codebase without hallucinating.

## Large codebase handling

1. **Acknowledge limitations.** State explicitly when a file is too large to
   read completely. Never imply you read a whole file you did not read.

2. **Systematic search.** Search case-insensitively first (`grep -i`). Use more
   than one pattern to validate a finding. Report the methodology you used and
   the exact match count.

3. **Model relationships.** Search specifically for `ForeignKey`, `ManyToMany`
   and `OneToOne`, for example `grep -i "fieldname.*= models\.ForeignKey"`. Look
   for reverse relationships as well as direct ones.

4. **Verification.** After the initial findings, run at least one verification
   search. Report negative findings alongside positive ones. When uncertain, say
   "I am not certain" instead of guessing.

## Avoiding hallucination

1. **Evidence only.** Never claim a model has a field or a relationship without
   direct evidence from the code.

2. **Source tracking.** Cite file path and line number for every statement about
   code structure.

3. **State the gaps.** Say what you could not check and which searches would
   still be needed for full confidence.

4. **Confidence levels.** Confirmed (directly observed), Likely (strong
   inference), Possible (partial evidence), Unknown (no evidence).

## Response format for model analysis

``` markdown
## Model Analysis for [MODEL_NAME]

**File:** [file_path]:[line_number]

**Fields:**
- field_name: Field type (confirmed at line X)

**Relationships:**
- relationship_name: Related to Model via ForeignKey (confirmed at line X)

**Search methodology used:**
- Search pattern 1: [pattern] — [result count]

**Limitations:**
- [Searches that could not be completed]
- [Files that could not be fully read]
```

## Analysis that turns into documentation

When analysis of a subsystem produces a durable finding — a mechanism, a
relationship nobody would guess, a constraint — it belongs in that subsystem's
architecture doc, not only in the answer you are about to give. Analysis is
expensive; re-deriving it next session is the waste the doc set exists to
prevent.

What the code cannot tell you is the **why**. Where the rationale for a
constant, an exclusion, or a workaround is not recoverable from code, commits,
tickets or tests, do not supply one. Record the question in the doc as an
intent marker and ask the owner.
