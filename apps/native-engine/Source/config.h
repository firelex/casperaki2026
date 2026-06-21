/*
  ==============================================================================

    config.h
    Created: 10 Oct 2023 10:23:13am
    Author:  abhis

  ==============================================================================
*/

#pragma once
#include "Logging.h"

#ifndef CONFIG_H
    #define CONFIG_H

//Set to 1 to run tests
#define SHOULD_RUN_TESTS 0

//If this is set to 0, all of the temporary intermediary files will be deleted
#define SHARE_WITH_STEFAN 0 //necessary to share project files with Stefan

//#define USE_CASPERAKI_SAMPLER
#define USE_TE_SAMPLER

#if SHARE_WITH_STEFAN
    #define SHOULD_RETAIN_PROJECT_FILES 1
    #define COPY_TO_SAMPLES_FOLDER 1
    #undef USE_CASPERAKI_SAMPLER
    #define USE_TE_SAMPLER
#else
    #define SHOULD_RETAIN_PROJECT_FILES 0
    #define COPY_TO_SAMPLES_FOLDER 0
#endif

#ifdef USE_CASPERAKI_SAMPLER
    #define SHOULD_APPLY_ADSR 1
#else
    #define SHOULD_APPLY_ADSR 0
#endif

#endif // CONFIG_H
