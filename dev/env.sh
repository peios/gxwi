#!/bin/sh
# Sourced by host-side qualification helpers; Bazel receives an explicit SDK.
: "${PEIOS_SDK:?Set PEIOS_SDK to the output of tools/prepare-dev-sdk}"
export PEIOS_SDK
