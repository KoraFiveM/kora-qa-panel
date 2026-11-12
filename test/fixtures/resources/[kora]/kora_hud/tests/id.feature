@kora_hud @legacy:hud-id @target:3 @needs:players:2
Feature: HUD id
  Scenario: /id toggles the server ID on the HUD
    When I run the command "/id"
    Then I confirm: the HUD shows my server ID and it matches the player list
