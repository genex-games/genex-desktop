//! ORCA local avoidance (optimal reciprocal collision avoidance), ported from dodgy_2d 0.5.5
//! (<https://github.com/andriyDev/dodgy>, MIT OR Apache-2.0, by andriyDev), itself a port of
//! RVO2 (Apache-2.0, notice below and in `THIRD-PARTY-NOTICES.md`).
//!
//! Changes from dodgy_2d (Apache-2.0 §4(b): these files were modified):
//! - P8: when two agents overlap with a relative velocity that points exactly at the collision
//!   circle's centre (two agents on one spot standing still), dodgy picked a direction with the
//!   `rand` crate, so replicas of one scene diverged. The port takes the perpendicular of the
//!   offset between the agents, and when the agents sit on one spot, a direction hashed from
//!   their two [`Agent::key`]s, pointing opposite ways for the two agents. `rand` is gone.
//! - P9: `Simulator::step` keeps no `HashMap` of pair distances; it now takes the neighbours it
//!   meant to (dodgy skipped the near ones and kept the far ones) and removes an agent's
//!   parameters with the agent.
//! - `VisibilitySet::get_visible_line_ids` returns sorted ids, not a `HashSet`, and its angles
//!   come from glam's libm math, so every destination gets the same bits.
//! - Two agents whose responsibilities sum to 0 (an agent set to 0 meeting a body) each take
//!   the whole avoidance; dodgy divided by zero there.
//! - `VisibilitySet` rebuilds its cone list in a spare buffer it keeps, instead of a new `Vec`
//!   grown from empty for every added cone, and makes an overlap's cone (its related angle) only
//!   where it keeps one (GE, NAV-18's update budget; the same bits).
//! - R-19 (NAV-18's update budget, the same bits): `VisibilitySet` also takes a line as two
//!   [`ConeRay`]s a caller made once per point and reuses, an overlap makes its cone's related
//!   angle's sine once for both of its rays, and a cone apart from an added one is kept before any
//!   ray of it is made.
//! - The `debug` feature and its `DebugData` are left out.
//! - Tests are dodgy's own (`*_test.rs` beside each file), with a key on every agent.
//!
// The contents of this file were primarily ported from Agent.cc from RVO2 with
// significant alterations. As per the Apache-2.0 license, the original
// copyright notice has been included, excluding those notices that do not
// pertain to the derivate work:
//
// Agent.cc
// RVO2 Library
//
// SPDX-FileCopyrightText: 2008 University of North Carolina at Chapel Hill
//
// The authors may be contacted via:
//
// Jur van den Berg, Stephen J. Guy, Jamie Snape, Ming C. Lin, Dinesh Manocha
// Dept. of Computer Science
// 201 S. Columbia St.
// Frederick P. Brooks, Jr. Computer Science Bldg.
// Chapel Hill, N.C. 27599-3175
// United States of America
//
// <https://gamma.cs.unc.edu/RVO2/>
mod common;
mod linear_programming;
mod obstacles;
mod simulator;
mod visibility_set;

use std::borrow::Cow;

use genex_core::digest::fnv1a64;
pub use glam::Vec2;

use common::*;
use linear_programming::{Line, solve_linear_program};
use obstacles::get_lines_for_agent_to_obstacle;

pub use obstacles::Obstacle;

pub use simulator::{AgentParameters, Simulator, SimulatorMargin};
pub use visibility_set::{ConeRay, VisibilitySet};

/// A single agent in the simulation.
#[derive(Clone, PartialEq, Debug)]
pub struct Agent {
    /// The position of the agent.
    pub position: Vec2,
    /// The current velocity of the agent.
    pub velocity: Vec2,

    /// The radius of the agent. Agents will use this to avoid bumping into each
    /// other.
    pub radius: f32,

    /// The amount of responsibility an agent has to avoid other agents. The
    /// amount of avoidance between two agents is then dependent on the ratio of
    /// the responsibility between the agents. Note this does not affect
    /// avoidance of obstacles.
    pub avoidance_responsibility: f32,

    /// A number unique among the agents (and bodies) one avoidance step sees, stable from tick
    /// to tick. Two agents on one spot push apart in a direction hashed from their keys.
    pub key: u64,
}

/// Parameters for computing the avoidance vector.
#[derive(Clone, PartialEq, Debug)]
pub struct AvoidanceOptions {
    /// The distance that the agent must be from any obstacle. This is commonly
    /// the agent's radius to ensure the agent never intersects the obstacle (for
    /// example a wall). An alternative is to set this to a small value to treat
    /// obstacles as the edge of something (like a cliff).
    pub obstacle_margin: f32,
    /// How long in the future should collisions be considered between agents.
    pub time_horizon: f32,
    /// How long in the future should collisions be considered for obstacles.
    pub obstacle_time_horizon: f32,
}

impl Agent {
    /// Computes a velocity based off the agent's preferred velocity (usually the
    /// direction to its current goal/waypoint). This new velocity is intended to
    /// avoid running into the agent's `neighbours`. This is not always possible,
    /// but agents will attempt to resolve any collisions in a reasonable fashion.
    /// The `max_speed` is the maximum magnitude of the returned velocity. Even if
    /// the `preferred_velocity` is larger than `max_speed`, the resulting vector
    /// will be at most `max_speed` in length. The `time_step` helps determine the
    /// velocity in cases of existing collisions, and must be positive.
    pub fn compute_avoiding_velocity(
        &self,
        neighbours: &[Cow<'_, Agent>],
        obstacles: &[Cow<'_, Obstacle>],
        preferred_velocity: Vec2,
        max_speed: f32,
        time_step: f32,
        avoidance_options: &AvoidanceOptions,
    ) -> Vec2 {
        assert!(time_step > 0.0, "time_step must be positive, was {}", time_step);

        let lines = obstacles
            .iter()
            .flat_map(|o| {
                get_lines_for_agent_to_obstacle(
                    self,
                    o,
                    avoidance_options.obstacle_margin,
                    avoidance_options.obstacle_time_horizon,
                )
            })
            .chain(neighbours.iter().map(|neighbour| {
                self.get_line_for_neighbour(
                    neighbour,
                    avoidance_options.time_horizon,
                    time_step,
                )
            }))
            .collect::<Vec<Line>>();

        // Since each neighbour generates one line, the number of obstacle lines is
        // just the other lines.
        let obstacle_line_count = lines.len() - neighbours.len();

        if let Ok(result) = solve_linear_program(
            &lines,
            obstacle_line_count,
            max_speed,
            preferred_velocity,
        ) {
            return result;
        }

        let zero_velocity_agent = {
            let mut clone = self.clone();
            clone.velocity = Vec2::ZERO;
            clone
        };

        let zero_velocity_lines = obstacles
            .iter()
            .flat_map(|o| {
                get_lines_for_agent_to_obstacle(
                    // Since the obstacle constraints failed last time, now fallback to
                    // pretending the agent is stationary for the purposes of generating
                    // trivially solvable obstacle constraints.
                    &zero_velocity_agent,
                    o,
                    avoidance_options.obstacle_margin,
                    avoidance_options.obstacle_time_horizon,
                )
            })
            .chain(neighbours.iter().map(|neighbour| {
                self.get_line_for_neighbour(
                    neighbour,
                    avoidance_options.time_horizon,
                    time_step,
                )
            }))
            .collect::<Vec<Line>>();

        // Since each neighbour generates one line, the number of obstacle lines is
        // just the other lines.
        let obstacle_line_count = zero_velocity_lines.len() - neighbours.len();

        // We're falling back, so no matter what, take whatever solution we get even
        // if it's infeasible.
        match solve_linear_program(
            &zero_velocity_lines,
            obstacle_line_count,
            max_speed,
            preferred_velocity,
        ) {
            Ok(result) => result,
            Err(result) => result,
        }
    }

    /// Creates a line to describe the half-plane of valid velocities that should
    /// not collide with `neighbour`.
    fn get_line_for_neighbour(
        &self,
        neighbour: &Agent,
        time_horizon: f32,
        time_step: f32,
    ) -> Line {
        // There are two parts to the velocity obstacle induced by `neighbour`.
        // 1) The cut-off circle. This is where the agent collides with `neighbour`
        // after some time (either `time_horizon` or `time_step`).
        // 2) The cut-off shadow. Any velocity that is just scaled up from a
        // velocity in the cut-off circle will also hit `neighbour`.
        //
        // If the relative position and velocity is used, the cut-off for the shadow
        // will be directed toward the origin.

        let relative_neighbour_position = neighbour.position - self.position;
        let relative_agent_velocity = self.velocity - neighbour.velocity;

        let distance_squared = relative_neighbour_position.length_squared();

        let sum_radius = self.radius + neighbour.radius;
        let sum_radius_squared = sum_radius * sum_radius;

        let vo_normal;
        let relative_velocity_projected_to_vo;
        let inside_vo;

        // Find out if the agent is inside the cut-off circle. Note: since both the
        // distance to the cut-off circle and the radius of the cut-off circle is
        // scaled by `time_horizon` (or `time_step` depending on the situation),
        // factoring out those terms and cancelling yields this simpler expression.
        if distance_squared > sum_radius_squared {
            // No collision, so either project on to the cut-off circle, or the
            // cut-off shadow.
            //
            // The edges of the cut-off shadow lies along the tangents of the circle
            // that intersects the origin (since the tangents are the lines that just
            // graze the cut-off circle and so these line divide the "shadowed"
            // velocities from the "unshadowed" velocities).
            //
            // Since the shadows are caused by the tangent lines, velocities should be
            // projected to the cut-off circle when they are on one-side of the
            // tangent points, and should be projected to the shadow when on the
            // other-side of the tangent points.

            let cutoff_circle_center = relative_neighbour_position / time_horizon;
            let cutoff_circle_center_to_relative_velocity =
                relative_agent_velocity - cutoff_circle_center;
            let cutoff_circle_center_to_relative_velocity_length_squared =
                cutoff_circle_center_to_relative_velocity.length_squared();

            let dot = cutoff_circle_center_to_relative_velocity
                .dot(relative_neighbour_position);

            // TODO: Figure out why this works. Something to do with circle tangents,
            // right triangles with those tangents, and the angle between
            // `cutoff_circle_center_to_relative_velocity` and
            // `relative_neighbour_position`.
            if dot < 0.0
                && dot * dot
                    > sum_radius_squared
                        * cutoff_circle_center_to_relative_velocity_length_squared
            {
                // The relative velocity has not gone past the cut-off circle tangent
                // points yet, so project onto the cut-off circle.

                let cutoff_circle_radius = sum_radius / time_horizon;

                vo_normal =
                    cutoff_circle_center_to_relative_velocity.normalize_or_zero();
                relative_velocity_projected_to_vo =
                    vo_normal * cutoff_circle_radius + cutoff_circle_center;
                inside_vo = cutoff_circle_center_to_relative_velocity_length_squared
                    < cutoff_circle_radius * cutoff_circle_radius;
            } else {
                // The relative velocity is past the cut-off circle tangent points, so
                // project onto the shadow.

                let tangent_triangle_leg =
                    (distance_squared - sum_radius_squared).sqrt();

                // Consider the right-triangle describing the tangent point (one side
                // has length `sum_radius`, hypotenuse has side length
                // `cutoff_circle_center_to_relative_velocity_length_squared`). The last
                // side will have length `tangent_triangle_leg`. A similar triangle can
                // then be created using the same triangle leg lengths, but oriented
                // such that the hypotenuse is in the direction of the tangent and
                // composed of directions `relative_position` and the perpendicular of
                // `relative_position`.

                // Determine whether the relative velocity is nearer the left or right
                // side of the shadow.
                let tangent_side = determinant(
                    relative_neighbour_position,
                    cutoff_circle_center_to_relative_velocity,
                )
                .signum();

                // Compute the shadow direction using the tangent triangle legs, and
                // make sure to use the correct orientation of that direction (the
                // correct side of the line is invalid).
                let shadow_direction =
                    relative_neighbour_position * tangent_triangle_leg * tangent_side
                        + relative_neighbour_position.perp() * sum_radius;

                // Renormalize the shadow direction.
                let shadow_direction = shadow_direction / distance_squared;

                vo_normal = shadow_direction.perp();
                // Project onto the shadow.
                relative_velocity_projected_to_vo =
                    relative_agent_velocity.project_onto_normalized(shadow_direction);
                // The velocity is inside the VO if it is to the left of the left
                // shadow, or the right of the right shadow.
                inside_vo =
                    determinant(relative_agent_velocity, shadow_direction) >= 0.0;
            }
        } else {
            // Collision. Project on cut-off circle at time `time_step`.

            // Find the velocity such that after `time_step` the agent would be at the
            // neighbours position.
            let cutoff_circle_center = relative_neighbour_position / time_step;
            let cutoff_circle_radius = sum_radius / time_step;

            // The direction of the velocity from `cutoff_circle_center` is therefore
            // the normal to the velocity obstacle.
            vo_normal = {
                let velocity_from_circle_center =
                    relative_agent_velocity - cutoff_circle_center;
                // If the vector has a length of zero, the agents collide head on: push
                // sideways, or apart in a hashed direction when they share a spot (P8).
                let recip = velocity_from_circle_center.length_recip();
                if recip.is_finite() && recip > 0.0 {
                    velocity_from_circle_center * recip
                } else {
                    self.tie_break_direction(neighbour, relative_neighbour_position)
                }
            };
            // Get the point on the cut-off circle in that direction (which is the
            // agent's velocity projected to the circle).
            relative_velocity_projected_to_vo =
                vo_normal * cutoff_circle_radius + cutoff_circle_center;
            inside_vo = true;
        }

        // As in the paper, `u` is the vector from the relative velocity to the
        // nearest point outside the velocity obstacle.
        let u = relative_velocity_projected_to_vo - relative_agent_velocity;

        let shared = self.avoidance_responsibility + neighbour.avoidance_responsibility;
        let responsibility = if inside_vo && shared > 0.0 {
            self.avoidance_responsibility / shared
        } else {
            1.0
        };

        Line {
            point: self.velocity + u * responsibility,
            direction: -vo_normal.perp(),
        }
    }

    /// The velocity-obstacle normal when the relative velocity sits exactly on the collision
    /// circle's centre (P8, replacing dodgy's `rand` draw): the perpendicular of the offset to
    /// `neighbour`, or, when the two share a spot, a unit direction hashed from both keys. Either
    /// way the neighbour computes the opposite direction, so the two push apart.
    fn tie_break_direction(&self, neighbour: &Agent, offset: Vec2) -> Vec2 {
        let sideways = offset.perp().normalize_or_zero();
        if sideways != Vec2::ZERO {
            return sideways;
        }
        let (low, high) = if self.key <= neighbour.key { (self.key, neighbour.key) } else { (neighbour.key, self.key) };
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&low.to_le_bytes());
        bytes[8..].copy_from_slice(&high.to_le_bytes());
        let hash = fnv1a64(&bytes);
        // Two 16-bit halves centred on zero: never the zero vector, no trigonometry.
        let x = (hash & 0xffff) as f32 - 32767.5;
        let y = ((hash >> 16) & 0xffff) as f32 - 32767.5;
        let direction = Vec2::new(x, y).normalize();
        if self.key > neighbour.key { -direction } else { direction }
    }
}

#[cfg(test)]
#[path = "lib_test.rs"]
mod test;
