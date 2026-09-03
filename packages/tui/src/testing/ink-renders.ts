/**
 * Makes Ink draw during tests the way it draws for a person.
 *
 * Ink reads `process.env.CI` and, when it is set, stops updating the screen as
 * it goes — which is right for a program printing progress into a log and
 * wrong for a test that asks what is on screen. Every render test in this
 * package read an empty buffer there and failed on something that was in fact
 * drawn, so the interface — a third of this repository — has never once been
 * checked by the pipeline that reports it green.
 *
 * Unset here rather than in each test, because the next render test written
 * would not know to do it and would pass locally.
 *
 * Nothing this project ships reads the variable: the harness decides what to
 * do with nobody watching from whether it has a terminal, not from something
 * somebody's shell might have set.
 */
delete process.env.CI
