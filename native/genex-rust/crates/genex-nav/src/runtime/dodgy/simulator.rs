//! A small fixed-step simulator over [`Agent`]s and [`Obstacle`]s, from dodgy_2d's
//! `simulator.rs` (MIT OR Apache-2.0). Changed (P9): no `HashMap` of pair distances; an agent's
//! neighbours are the agents within its query distance (dodgy kept the far ones), in index
//! order; removing an agent removes its parameters too. As in dodgy, the obstacles are stored
//! but not yet fed to the agents (genex's runtime avoidance is `runtime::avoidance`).

use std::borrow::Cow;

use glam::Vec2;

use crate::runtime::dodgy::{Agent, AvoidanceOptions, Obstacle};

/// Agents and obstacles stepped together.
pub struct Simulator {
    agents: Vec<Agent>,
    agent_parameters: Vec<AgentParameters>,
    obstacles: Vec<Obstacle>,
}

/// How one agent moves in a [`Simulator`].
pub struct AgentParameters {
    /// Where the agent walks to.
    pub goal_point: Vec2,
    /// Its top speed.
    pub max_speed: f32,
    /// How far it keeps from obstacles.
    pub obstacle_margin: SimulatorMargin,
    /// How far ahead, in time, it avoids other agents.
    pub time_horizon: f32,
    /// How far ahead, in time, it avoids obstacles.
    pub obstacle_time_horizon: f32,
}

/// An agent's margin from obstacles.
pub enum SimulatorMargin {
    /// Its own radius.
    AgentRadius,
    /// A fixed distance.
    Distance(f32),
}

impl Simulator {
    /// An empty simulator.
    pub fn new() -> Simulator {
        Self { agents: Vec::new(), agent_parameters: Vec::new(), obstacles: Vec::new() }
    }

    /// Adds an agent with its parameters.
    pub fn add_agent(&mut self, agent: Agent, agent_parameters: AgentParameters) {
        self.agents.push(agent);
        self.agent_parameters.push(agent_parameters);
    }

    /// Adds an obstacle.
    pub fn add_obstacle(&mut self, obstacle: Obstacle) {
        self.obstacles.push(obstacle);
    }

    /// Removes an agent and its parameters; later agents move down one index.
    pub fn remove_agent(&mut self, agent_index: usize) {
        self.agents.remove(agent_index);
        self.agent_parameters.remove(agent_index);
    }

    /// Removes an obstacle; later obstacles move down one index.
    pub fn remove_obstacle(&mut self, obstacle_index: usize) {
        self.obstacles.remove(obstacle_index);
    }

    /// An agent.
    pub fn get_agent(&self, agent_index: usize) -> &Agent {
        &self.agents[agent_index]
    }

    /// An agent, to change.
    pub fn get_agent_mut(&mut self, agent_index: usize) -> &mut Agent {
        &mut self.agents[agent_index]
    }

    /// Agents in the simulator.
    pub fn get_agent_count(&self) -> usize {
        self.agents.len()
    }

    /// Obstacles in the simulator.
    pub fn get_obstacle_count(&self) -> usize {
        self.obstacles.len()
    }

    /// An agent's parameters.
    pub fn get_agent_parameters(&self, agent_index: usize) -> &AgentParameters {
        &self.agent_parameters[agent_index]
    }

    /// An agent's parameters, to change.
    pub fn get_agent_parameters_mut(&mut self, agent_index: usize) -> &mut AgentParameters {
        &mut self.agent_parameters[agent_index]
    }

    /// Every agent's avoiding velocity toward its goal, then every agent moves by it for
    /// `time_step` (positive).
    pub fn step(&mut self, time_step: f32) {
        let near_obstacles: Vec<Cow<'_, Obstacle>> = Vec::new();
        let mut new_velocities = Vec::with_capacity(self.agents.len());
        for (index, (agent, parameters)) in self.agents.iter().zip(self.agent_parameters.iter()).enumerate() {
            let query_distance = parameters.max_speed * parameters.time_horizon + agent.radius * 2.0;
            let neighbours: Vec<Cow<'_, Agent>> = self
                .agents
                .iter()
                .enumerate()
                .filter(|(other_index, other)| *other_index != index && agent.position.distance_squared(other.position) <= query_distance * query_distance)
                .map(|(_, other)| Cow::Borrowed(other))
                .collect();

            new_velocities.push(agent.compute_avoiding_velocity(
                &neighbours,
                &near_obstacles,
                parameters.goal_point - agent.position,
                parameters.max_speed,
                time_step,
                &AvoidanceOptions {
                    obstacle_margin: match parameters.obstacle_margin {
                        SimulatorMargin::AgentRadius => agent.radius,
                        SimulatorMargin::Distance(v) => v,
                    },
                    time_horizon: parameters.time_horizon,
                    obstacle_time_horizon: parameters.obstacle_time_horizon,
                },
            ));
        }

        for (agent, new_velocity) in self.agents.iter_mut().zip(new_velocities) {
            agent.velocity = new_velocity;
            agent.position += new_velocity * time_step;
        }
    }
}

impl Default for Simulator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "simulator_test.rs"]
mod test;
