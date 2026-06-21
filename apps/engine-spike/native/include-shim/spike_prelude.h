// Phase 2 spike prelude — force-included into every TU to paper over Linux
// vs. macOS portability bugs in the legacy engine source. Do not commit any
// of this into casperaki_engine itself; that repo's modernization is its own
// task.
#pragma once
#include <cmath>
#include <cstdint>

using std::isnan;
using std::isinf;
using std::fmod;
using std::floor;
using std::ceil;
using std::abs;
using std::pow;
using std::sqrt;
