---
title: Interaction Markup
type: reference
description: Choose declarative controls, keyboard actions, menus, and shell presentation.
---

Live-surface HTML describes actions for the compositor to dispatch.
Attributes do not replace validation in the application. The Rust `Live`
API documentation gives the complete markup contract.

## Actions and forms

The common action attributes serve these purposes:

| Attribute | Purpose |
|---|---|
| `fx-click` | Named activation action |
| `fx-dblclick` | Named repeated activation action |
| `fx-value-*` | Values associated with an action |
| `fx-submit` | Named form submission action |
| `fx-autofocus` | Focus target when a control appears |
| `fx-key` | Surface-local keyboard activation |

Named input fields belong to the surface. Validate form and action values
in the process before calling a backend. Escape text when generating HTML
attributes as well as element content.

## Keyboard and menus

A keyboard chord uses modifiers such as `Ctrl`, `Alt`, `Shift`, and `Meta`
with a key name. Field-editing shortcuts remain field operations where
appropriate. The desktop reserves its own chords, so an application cannot
assume every chord reaches its handler.

`fx-menu` identifies a hidden `menu` element. Its action items provide
labels and values; the compositor presents the menu. A disabled item
cannot be selected through the normal interface, but its handler must
still enforce operation validity and access.

## Device-local presentation

`fx-copy` copies the named value to the activating device's clipboard.
This is distinct from an application-owned clipboard shared through a
session file or service.

`fx-columns` lets a view resize columns. `fx-reorder` reports a requested
reordering with a destination position. The next process rendering remains
the authority for the accepted application order.

## Shell presentation

Authorized shell surfaces can describe desktop focus, workspace, and
overlay actions. `fx-focus`, `fx-workspace`, and `fx-overlay` affect the
presenting device where the compositor implements them. They do not make
focus into shared process state.

`fx-global-key` names a desktop-wide chord for a shell control. Requesting
that attribute does not make an ordinary application a shell. The
compositor determines which program connections have that authority.
