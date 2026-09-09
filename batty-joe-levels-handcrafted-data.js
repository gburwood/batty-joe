/* Batty Joe Handcrafted Levels Data */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};

  // Handcrafted levels data (converted from batty-joe-levels-handcrafted.yaml)
  BJ.HandcraftedLevelsData = {
    metadata: {
      version: '1.10.0',
      created_at: '2026-09-09T00:00:00Z',
      status: 'framework'
    },
    designer_levels: [
      {
        id: 'designer_tutorial_01',
        campaign_level: 1,
        title: 'Tutorial: The Basics',
        description: 'A gentle introduction to paddle control and brick destruction. No surprises, just learning the rhythm.',
        difficulty: 'easy',
        metadata: {
          version: '1.10.0',
          created_by: 'designer',
          created_at: '2026-09-09T00:00:00Z',
          tags: ['tutorial', 'beginner-friendly']
        },
        bricks: [
          // Row 0: Two rows of standard bricks to warm up
          { col: 1, row: 0, type: 'standard', durability: 1 },
          { col: 2, row: 0, type: 'standard', durability: 1 },
          { col: 3, row: 0, type: 'standard', durability: 1 },
          { col: 4, row: 0, type: 'standard', durability: 1 },
          { col: 5, row: 0, type: 'standard', durability: 1 },
          { col: 6, row: 0, type: 'standard', durability: 1 },
          { col: 7, row: 0, type: 'standard', durability: 1 },
          { col: 8, row: 0, type: 'standard', durability: 1 },
          { col: 9, row: 0, type: 'standard', durability: 1 },
          { col: 10, row: 0, type: 'standard', durability: 1 },
          // Row 1: Similar pattern
          { col: 1, row: 1, type: 'standard', durability: 1 },
          { col: 2, row: 1, type: 'standard', durability: 1 },
          { col: 3, row: 1, type: 'standard', durability: 1 },
          { col: 4, row: 1, type: 'standard', durability: 1 },
          { col: 5, row: 1, type: 'standard', durability: 1 },
          { col: 6, row: 1, type: 'standard', durability: 1 },
          { col: 7, row: 1, type: 'standard', durability: 1 },
          { col: 8, row: 1, type: 'standard', durability: 1 },
          { col: 9, row: 1, type: 'standard', durability: 1 },
          { col: 10, row: 1, type: 'standard', durability: 1 }
        ]
      }
    ],
    challenge_levels: []
  };

}(window));
