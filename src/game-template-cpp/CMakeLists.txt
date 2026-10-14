cmake_minimum_required(VERSION 3.28)
project(game CXX C)
include("${GENEX_CMAKE}")
genex_add_game(SOURCES src/*.cpp)
