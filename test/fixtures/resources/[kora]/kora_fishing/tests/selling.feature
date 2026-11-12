@kora_fishing @target:3
Feature: Selling fish

  Background:
    Given I am at "pier"

  @legacy:fish-sell @smoke
  Scenario: Selling a fish pays cash
    """
    1. Catch a fish and sell it at the shop.
    Expect: cash goes up.
    """
    Given I have 2 "fish"
    And my cash balance is 100
    When I go to "shop"
    And I select the "Sell fish" target option
    Then I should have no "fish"
    And my cash balance should have changed by 50
    Then I confirm: the shopkeeper says thanks

  Scenario Outline: Selling <n> fish
    Given I have <n> "fish"
    When I manually: sell all fish
    Then I should have 0 "fish"
    Examples:
      | n |
      | 1 |
      | 5 |

  Scenario: Over the caps
    Given I have 500 "fish"
    And I have 1 "weapon_rpg"
    And a "tank" is spawned in front of me
    And I am at "nowhere"
    And I run setup "missing_fixture"
    When I dance the macarena

  @wip
  Scenario: Work in progress
    When I manually: something
