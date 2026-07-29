import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { makeReferenceContext, makeThrowingReferenceContext } from './reference-plugin.js';

// The suite's positive control, and the only run of it that needs no server: an in-memory plugin
// the repo controls, which must pass in full. Both arms of the seam's absent-topic MAY are covered
// here, because no shipped backend takes the throwing arm and nothing else would ever grade it.
runConformanceSuite('reference (in-memory)', makeReferenceContext);
runConformanceSuite('reference (NoSuchTopicError on an absent topic)', makeThrowingReferenceContext);
