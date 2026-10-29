//! The plant generator's rows: a seed is a plant (byte for byte), seeds differ, every species and
//! season grows within its budgets, levels coarsen with the same parts, the GLBs open as the
//! renderer reads them (two parts, cut-out two-sided foliage that lets light through, bark with a
//! normal map and ORM), and the model handle carries its levels, impostor and wind.

use genex_render::mesh::GlbModel;

use super::*;

/// Maps small enough for unoptimized test builds.
const TEST_TEXELS: u32 = 128;

fn spec(species: Species, season: Season) -> PlantSpec {
    PlantSpec::new(species, season).texture_size(TEST_TEXELS)
}

/// The most triangles a full level may have (a hero tree within the desktop budget).
const FULL_TRIANGLES_MAX: u32 = 60_000;

#[test]
fn a_seed_grows_the_same_bytes_and_another_seed_another_plant() {
    let birch = spec(Species::Birch, Season::Winter).seed(7);
    let (a, b) = (plant_glb(&birch), plant_glb(&birch));
    assert_eq!(a.levels, b.levels, "the same spec writes the same GLBs");
    let other = plant_glb(&birch.seed(8));
    assert_ne!(a.levels[0], other.levels[0], "another seed grows another birch");
    assert_eq!(a.facts.texture_size, TEST_TEXELS);
}

#[test]
fn every_species_and_season_grows_within_its_budget_and_coarsens() {
    for species in Species::ALL {
        for season in Season::ALL {
            let glb = plant_glb(&spec(species, season).seed(3));
            let facts = &glb.facts;
            let what = format!("{} {}", species.wire(), season.wire());
            assert_eq!(glb.levels.len(), PLANT_LEVELS, "{what}");
            assert!(facts.triangles[0] > 0 && facts.triangles[0] <= FULL_TRIANGLES_MAX, "{what}: {} triangles at full detail", facts.triangles[0]);
            assert!(facts.triangles[1] < facts.triangles[0] && facts.triangles[2] < facts.triangles[1], "{what}: levels coarsen {:?}", facts.triangles);
            assert!(facts.cards.iter().all(|cards| *cards > 0), "{what}: every level keeps foliage {:?}", facts.cards);
            assert!(glb.distances[0] > 0.0 && glb.distances[1] > glb.distances[0], "{what}: {:?}", glb.distances);
            assert_eq!(facts.impostor, species != Species::Grass, "{what}");
            let parts: Vec<usize> = glb.levels.iter().map(|level| GlbModel::parts_from_glb(level).expect("opens").len()).collect();
            let expected = if species == Species::Grass { 1 } else { 2 };
            assert!(parts.iter().all(|count| *count == expected), "{what}: every level has the same parts {parts:?}");
        }
    }
}

#[test]
fn the_height_and_the_map_size_follow_the_spec_and_are_held() {
    let tall = plant_glb(&spec(Species::Spruce, Season::Leafy).height(25.0));
    assert_eq!(tall.facts.height, 25.0);
    let parts = GlbModel::parts_from_glb(&tall.levels[0]).expect("opens");
    let top = parts.iter().flat_map(|part| part.mesh.vertices.iter()).map(|v| v.position[1]).fold(0.0_f32, f32::max);
    assert!((22.0..28.0).contains(&top), "a 25 m spruce reaches {top} m");
    assert_eq!(PlantSpec::new(Species::Oak, Season::Leafy).height(f32::NAN).grown_height(), PlantSpec::new(Species::Oak, Season::Leafy).grown_height());
    assert_eq!(PlantSpec::new(Species::Oak, Season::Leafy).height(1.0e6).grown_height(), PLANT_HEIGHT_MAX);
    assert_eq!(PlantSpec::new(Species::Oak, Season::Leafy).texture_size(700), PlantSpec::new(Species::Oak, Season::Leafy).texture_size(1024));
    assert_eq!(PlantSpec::new(Species::Oak, Season::Leafy).texture_size(1).texture_size(5000), PlantSpec::new(Species::Oak, Season::Leafy).texture_size(PLANT_TEXTURE_MAX));
}

#[test]
fn the_full_level_carries_bark_pbr_and_cut_out_two_sided_leaves() {
    let glb = plant_glb(&spec(Species::Birch, Season::Leafy).seed(1));
    let model = GlbModel::from_glb(&glb.levels[0]).expect("a GLB the renderer reads");
    let parts = model.parts();
    let bark = parts[0].material.as_ref().expect("bark material");
    assert!(bark.base_texture.is_some() && bark.normal_texture.is_some() && bark.metal_rough_texture.is_some() && bark.occlusion_texture.is_some(), "bark has albedo, normal and ORM");
    assert_eq!((bark.alpha_cutoff, bark.double_sided), (None, false));
    let leaves = parts[1].material.as_ref().expect("foliage material");
    assert!(leaves.base_texture.is_some() && leaves.normal_texture.is_some(), "the cards have their atlas and its normal map");
    assert_eq!((leaves.alpha_cutoff, leaves.double_sided), (Some(0.5), true), "cut out and two-sided");
    let lets_light = parts[1].material_ext.and_then(|ext| ext.subsurface()).is_some_and(|subsurface| subsurface.transmission > 0.0);
    assert!(lets_light, "the leaves let the sun through");
    let coarse = GlbModel::parts_from_glb(&glb.levels[2]).expect("opens");
    assert_eq!(coarse.len(), parts.len());
}

#[test]
fn a_birch_reads_white_and_a_winter_birch_is_bare() {
    let mean_bark = |species: Species| {
        let glb = plant_glb(&spec(species, Season::Leafy));
        let model = GlbModel::from_glb(&glb.levels[0]).expect("opens");
        let image = model.parts()[0].material.as_ref().and_then(|m| m.base_texture).expect("bark texture");
        let texels = GlbModel::image_from_glb(&glb.levels[0], image).expect("decodes");
        texels.rgba().chunks(4).map(|t| f32::from(t[0]) + f32::from(t[1]) + f32::from(t[2])).sum::<f32>() / (3.0 * (texels.rgba().len() / 4) as f32)
    };
    assert!(mean_bark(Species::Birch) > 1.6 * mean_bark(Species::Oak), "birch bark is far lighter than oak's");
    // The share of a birch's covered card texels that are leaf-green (green well over red).
    let green = |season: Season| {
        let glb = plant_glb(&spec(Species::Birch, season));
        let model = GlbModel::from_glb(&glb.levels[0]).expect("opens");
        let image = model.parts()[1].material.as_ref().and_then(|m| m.base_texture).expect("card texture");
        let texels = GlbModel::image_from_glb(&glb.levels[0], image).expect("decodes");
        let covered: Vec<&[u8]> = texels.rgba().chunks(4).filter(|t| t[3] > 127).collect();
        covered.iter().filter(|t| u32::from(t[1]) > u32::from(t[0]) + 20).count() as f32 / covered.len().max(1) as f32
    };
    let (leafy, winter) = (green(Season::Leafy), green(Season::Winter));
    assert!(leafy > 0.5 && winter < 0.05, "a summer birch's cards are leaves ({leafy}), a winter birch's bare twigs ({winter})");
}

#[test]
fn the_model_carries_its_levels_impostor_and_wind() {
    let cache = PlantCache::default();
    let pine = spec(Species::Pine, Season::Leafy).seed(2);
    let model = cache.plant(&pine);
    assert!(!model.is_missing());
    assert_eq!(model.wind(), Some(WindResponse::tree()));
    assert_eq!(model.impostor(), Some(Impostor::hemi()));
    assert_eq!(model.lod_refusal(), None);
    assert_eq!(model.lod_options().map(|lod| lod.levels.len()), Some(PLANT_LEVELS - 1));
    assert_eq!(cache.plant(&pine), model, "a spec grows once and is handed out again");
    let grass = cache.plant(&spec(Species::Grass, Season::Leafy));
    assert_eq!((grass.wind(), grass.impostor()), (Some(WindResponse::grass()), None));
}
